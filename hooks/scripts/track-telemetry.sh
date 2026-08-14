#!/bin/bash

# Telemetry tracking hook for Aspire Skills.
#
# Runs on every agent PostToolUse event. Reads the hook JSON from stdin, detects when an
# Aspire skill, Aspire MCP tool, or Aspire skill reference file was used, and forwards a
# low-cardinality usage event to `aspire agent telemetry`. The Aspire CLI command owns the
# actual opt-out + publishing logic; this script only classifies the event and shells out.
#
# Hook contract: a PostToolUse hook MUST always print a single JSON object to stdout and exit
# 0, otherwise it can break the agent session. A single EXIT trap guarantees that response is
# emitted exactly once, however the script leaves.
#
# === Client format reference ===
#
# Copilot CLI:
#   - Field names: camelCase (toolName, sessionId, toolArgs) when the hook event is configured
#     in camelCase (postToolUse); snake_case (tool_name, ...) when configured in PascalCase
#     (PostToolUse, "VS Code compatible" payload). We handle both.
#   - Tool names: lowercase (skill, view)
#   - Aspire MCP prefix: aspire-<tool>            (e.g. aspire-list_resources)
#   - Detection: COPILOT_CLI=1, or a "toolArgs" field present
#
# Claude Code:
#   - Field names: snake_case (tool_name, session_id, tool_input, hook_event_name)
#   - Tool names: PascalCase (Skill, Read, Edit)
#   - Aspire MCP prefix: mcp__aspire__<tool>      (server named "aspire" in .mcp.json)
#   - Skill prefix: aspire:<skill-name> (plugin install) — stripped before allowlist match
#   - Detection: has "hook_event_name", tool_use_id does NOT contain "__vscode"
#
# VS Code:
#   - Field names: snake_case (tool_name, session_id, tool_input, hook_event_name)
#   - Tool names: snake_case (read_file)
#   - Aspire MCP prefix: mcp_aspire_<tool>
#   - Detection: has "hook_event_name", tool_use_id contains "__vscode" or transcript_path has /Code/
#
# === Event types emitted ===
#
# 1. skill_invocation     - the skill/Skill tool ran with an Aspire skill name, OR a SKILL.md
#                           under .../skills/<aspire-skill>/SKILL.md was read.   (--skill-name)
# 2. tool_invocation      - a tool matching an Aspire MCP prefix ran.            (--tool-name)
# 3. reference_file_read  - a non-SKILL.md file under .../skills/<aspire-skill>/ was read.
#                                                                                (--file-reference)
#
# Privacy: only Aspire-owned identifiers are forwarded. Skill/tool names are matched against an
# allowlist of the skills shipped by github.com/microsoft/aspire-skills, and reference files are
# only forwarded as the repo-relative path *after* skills/<skill>/ — never absolute paths, repo
# names, or user names. The Aspire CLI command independently re-validates and drops anything else.

# Never abort the agent: failures must be silent and we must still emit {"continue":true}.
set +e

# Hook contract enforcement: always print exactly one {"continue":true} and exit 0, however the
# script leaves — normal completion, an early `exit 0`, or an unexpected failure under `set +e`.
# A single EXIT trap is the one guaranteed emit point, so every other path just calls `exit 0`
# and never prints the response itself.
_emitted=0
emit_continue() {
    [ "$_emitted" -eq 0 ] || return 0
    _emitted=1
    printf '%s\n' '{"continue":true}'
}
trap emit_continue EXIT

# Allowlist of Aspire-owned skill names (must stay in sync with the skills shipped by
# github.com/microsoft/aspire-skills). A shared .agents/skills directory can also contain
# third-party skills (dotnet-inspect, playwright, ...), so a path/name is only treated as
# Aspire when its skill segment is one of these.
ASPIRE_SKILLS="aspire aspire-init aspireify aspire-orchestration aspire-deployment aspire-monitoring"

ASPIRE_MCP_TOOLS="doctor execute_resource_command get_doc list_apphosts list_console_logs list_docs list_integrations list_resources list_structured_logs list_trace_structured_logs list_traces refresh_tools search_docs select_apphost"

# Only paths shipped by this repository are safe telemetry dimensions. Project-local skill
# overrides can add arbitrary filenames beneath an Aspire skill directory, so a path is not
# forwarded merely because it lives under skills/<aspire-skill>/.
ASPIRE_REFERENCE_FILES="
aspire-deployment/references/aws.md
aspire-deployment/references/azure.md
aspire-deployment/references/cicd.md
aspire-deployment/references/docker-compose.md
aspire-deployment/references/github-actions-azure-csharp.yml
aspire-deployment/references/github-actions-azure-typescript.yml
aspire-deployment/references/javascript.md
aspire-deployment/references/kubernetes.md
aspire-deployment/references/preflight.md
aspire-init/references/init-workflow.md
aspire-init/references/templates.md
aspire-monitoring/references/diagnostics-bridge.md
aspire-monitoring/references/monitoring.md
aspire-monitoring/references/playwright-handoff.md
aspire-orchestration/references/agent-workflows.md
aspire-orchestration/references/app-commands.md
aspire-orchestration/references/detection.md
aspire-orchestration/references/resource-management.md
aspire-orchestration/references/safety-guardrails.md
aspire/references/aspire-13-3-breaking-changes.md
aspireify/references/apphost-wiring.md
aspireify/references/csharp-authoring.md
aspireify/references/docker-compose.md
aspireify/references/full-solution-apphosts.md
aspireify/references/javascript-apps.md
aspireify/references/opentelemetry.md
aspireify/references/scan-and-propose.md
aspireify/references/service-defaults.md
aspireify/references/typescript-authoring.md
aspireify/references/validation.md
"

# Opt out when the Aspire CLI telemetry switch is set. This is the single opt-out that also
# gates the `aspire agent telemetry` command path, so honoring it here avoids spawning the CLI
# at all for opted-out users. Lower-case first so the accepted set (1 / any-case true) matches
# the PowerShell hook's case-insensitive check exactly.
case "$(printf '%s' "${ASPIRE_CLI_TELEMETRY_OPTOUT}" | tr '[:upper:]' '[:lower:]')" in
    1|true) exit 0 ;;
esac

# Extract one top-level JSON value without consulting tool result fields. This small parser handles
# the two value shapes the hooks need: JSON strings and nested objects. It validates the enclosing
# object before returning a value, so malformed Aspire-shaped input is ignored instead of guessed.
extract_json_value() {
    printf '%s' "$1" | awk -v target="$2" '
        function skip_ws() {
            while (position <= json_length && substr(json, position, 1) ~ /[ \t\r\n]/) {
                position++
            }
        }

        function parse_string(    value, character, escape) {
            if (substr(json, position, 1) != "\"") {
                return 0
            }

            position++
            value = ""
            while (position <= json_length) {
                character = substr(json, position, 1)
                if (character == "\"") {
                    position++
                    parsed_value = value
                    return 1
                }

                if (character == "\\") {
                    position++
                    if (position > json_length) {
                        return 0
                    }

                    escape = substr(json, position, 1)
                    if (escape == "\"" || escape == "\\" || escape == "/") {
                        value = value escape
                    }
                    else if (escape == "b") {
                        value = value sprintf("%c", 8)
                    }
                    else if (escape == "f") {
                        value = value sprintf("%c", 12)
                    }
                    else if (escape == "n") {
                        value = value "\n"
                    }
                    else if (escape == "r") {
                        value = value "\r"
                    }
                    else if (escape == "t") {
                        value = value "\t"
                    }
                    else if (escape == "u") {
                        if (position + 4 > json_length ||
                            substr(json, position + 1, 4) !~ /^[0-9A-Fa-f]{4}$/) {
                            return 0
                        }

                        # Aspire identifiers and allowlisted paths are ASCII. Preserve a valid
                        # Unicode escape so it cannot be confused with an allowlisted value.
                        value = value "\\u" substr(json, position + 1, 4)
                        position += 4
                    }
                    else {
                        return 0
                    }
                }
                else {
                    value = value character
                }

                position++
            }

            return 0
        }

        function parse_compound(    start, opening, closing, depth, in_string, escaped, character) {
            start = position
            opening = substr(json, position, 1)
            closing = opening == "{" ? "}" : "]"
            depth = 0
            in_string = 0
            escaped = 0

            while (position <= json_length) {
                character = substr(json, position, 1)
                if (in_string) {
                    if (escaped) {
                        escaped = 0
                    }
                    else if (character == "\\") {
                        escaped = 1
                    }
                    else if (character == "\"") {
                        in_string = 0
                    }
                }
                else if (character == "\"") {
                    in_string = 1
                }
                else if (character == opening) {
                    depth++
                }
                else if (character == closing) {
                    depth--
                    if (depth == 0) {
                        position++
                        parsed_value = substr(json, start, position - start)
                        return 1
                    }
                }

                position++
            }

            return 0
        }

        function parse_value(    character, start) {
            skip_ws()
            character = substr(json, position, 1)
            if (character == "\"") {
                return parse_string()
            }

            if (character == "{" || character == "[") {
                return parse_compound()
            }

            start = position
            while (position <= json_length &&
                   substr(json, position, 1) !~ /[,}]/) {
                position++
            }

            parsed_value = substr(json, start, position - start)
            gsub(/^[ \t\r\n]+|[ \t\r\n]+$/, "", parsed_value)
            return parsed_value ~ /^(true|false|null|-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?)$/
        }

        {
            json = json $0 "\n"
        }

        END {
            json_length = length(json)
            position = 1
            skip_ws()
            if (substr(json, position, 1) != "{") {
                exit
            }

            position++
            found = 0
            while (position <= json_length) {
                skip_ws()
                if (substr(json, position, 1) == "}") {
                    position++
                    skip_ws()
                    if (position <= json_length) {
                        exit
                    }

                    if (found) {
                        printf "%s", found_value
                    }
                    exit
                }

                if (!parse_string()) {
                    exit
                }
                key = parsed_value
                skip_ws()
                if (substr(json, position, 1) != ":") {
                    exit
                }

                position++
                if (!parse_value()) {
                    exit
                }
                if (!found && key == target) {
                    found = 1
                    found_value = parsed_value
                }

                skip_ws()
                character = substr(json, position, 1)
                if (character == ",") {
                    position++
                }
                else if (character != "}") {
                    exit
                }
            }
        }
    '
}

extract_input_field() {
    extract_json_value "$toolInput" "$1"
}

# Return the path beginning at the final recognized skills/<aspire-skill>/ segment. Choosing from
# right to left handles workspaces whose parent directories also contain a skills directory.
extract_aspire_skill_path() {
    printf '%s' "$1" | awk -F/ -v skills="$ASPIRE_SKILLS" '
        BEGIN {
            count = split(skills, names, " ")
            for (i = 1; i <= count; i++) {
                allowed[names[i]] = 1
            }
        }
        {
            for (i = NF - 2; i >= 1; i--) {
                if ($i == "skills" && allowed[$(i + 1)]) {
                    value = $(i + 1)
                    for (j = i + 2; j <= NF; j++) {
                        value = value "/" $j
                    }
                    print value
                    exit
                }
            }
        }
    '
}

# Return 0 when $1 is an allowlisted Aspire skill name.
is_aspire_skill() {
    local candidate="$1" name
    for name in $ASPIRE_SKILLS; do
        if [ "$candidate" = "$name" ]; then
            return 0
        fi
    done
    return 1
}

is_aspire_mcp_tool() {
    local candidate="$1" name
    for name in $ASPIRE_MCP_TOOLS; do
        if [ "$candidate" = "$name" ]; then
            return 0
        fi
    done
    return 1
}

is_aspire_reference() {
    local candidate="$1" reference
    for reference in $ASPIRE_REFERENCE_FILES; do
        if [ "$candidate" = "$reference" ]; then
            return 0
        fi
    done
    return 1
}

is_session_id() {
    printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
}

# No stdin (interactive) means nothing to track.
if [ -t 0 ]; then
    exit 0
fi

rawInput=$(cat)
if [ -z "$rawInput" ]; then
    exit 0
fi

# Fast path: the vast majority of PostToolUse events are not Aspire-related. Everything we track
# carries "skill"/"Skill" or "aspire" somewhere in the payload (the skill tool name, an aspire-/
# mcp__aspire__ tool name, or a .../skills/<aspire-skill>/ path), so when none of those appear we
# return immediately and skip all of the sed/grep extraction below.
case "$rawInput" in
    *skill*|*Skill*|*aspire*|*Aspire*) ;;
    *) exit 0 ;;
esac

toolName=$(extract_json_value "$rawInput" "toolName")
[ -z "$toolName" ] && toolName=$(extract_json_value "$rawInput" "tool_name")

sessionId=$(extract_json_value "$rawInput" "sessionId")
[ -z "$sessionId" ] && sessionId=$(extract_json_value "$rawInput" "session_id")
[ -n "$sessionId" ] && ! is_session_id "$sessionId" && sessionId=""

toolInput=$(extract_json_value "$rawInput" "toolArgs")
[ -z "$toolInput" ] && toolInput=$(extract_json_value "$rawInput" "tool_input")

timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Detect the client (used only for a low-cardinality client-name tag).
if [ "$COPILOT_CLI" = "1" ]; then
    clientName="copilot-cli"
elif printf '%s' "$rawInput" | grep -q '"hook_event_name"'; then
    toolUseId=$(extract_json_value "$rawInput" "tool_use_id")
    transcriptPath=$(extract_json_value "$rawInput" "transcript_path")
    transcriptPathNorm=$(printf '%s' "$transcriptPath" | tr '\\' '/')
    case "$toolUseId$transcriptPathNorm" in
        *__vscode*|*/Code/*|*/Code\ -\ Insiders/*) clientName="vscode" ;;
        *) clientName="claude-code" ;;
    esac
elif printf '%s' "$rawInput" | grep -q '"toolArgs"'; then
    clientName="copilot-cli"
else
    clientName="unknown"
fi

# Nothing to classify without a tool name.
if [ -z "$toolName" ]; then
    exit 0
fi

shouldTrack=false
eventType=""
skillName=""
mcpToolName=""
fileReference=""

# --- skill_invocation via the skill/Skill tool ---
if [ "$toolName" = "skill" ] || [ "$toolName" = "Skill" ]; then
    candidate=$(extract_input_field "skill")
    # Claude prefixes plugin skill names, e.g. "aspire:aspire-deployment".
    candidate="${candidate#aspire:}"
    if is_aspire_skill "$candidate"; then
        skillName="$candidate"
        eventType="skill_invocation"
        shouldTrack=true
    fi
fi

# --- skill_invocation / reference_file_read via a file read tool ---
# Copilot CLI: view, Claude Code: Read, VS Code: read_file.
if [ "$toolName" = "view" ] || [ "$toolName" = "Read" ] || [ "$toolName" = "read_file" ]; then
    pathToCheck=""
    for field in path filePath file_path; do
        pathToCheck=$(extract_input_field "$field")
        if [ -n "$pathToCheck" ]; then
            break
        fi
    done
    if [ -n "$pathToCheck" ]; then
        # Normalize separators and collapse duplicate slashes. Example inputs:
        #   .agents/skills/aspire/SKILL.md
        #   /home/me/proj/.github/skills/aspire-deployment/references/deploy.md
        #   C:\src\.claude\skills\aspireify\SKILL.md
        normalized=$(printf '%s' "$pathToCheck" | tr '\\' '/' | sed 's|//*|/|g')
        skillPath=$(extract_aspire_skill_path "$normalized")
        if [ -n "$skillPath" ]; then
            skillSegment="${skillPath%%/*}"
            case "$skillPath" in
                */SKILL.md|SKILL.md|*/skill.md|skill.md)
                    # A SKILL.md read is a skill invocation, not a reference-file read.
                    if [ "$shouldTrack" = false ]; then
                        skillName="$skillSegment"
                        eventType="skill_invocation"
                        shouldTrack=true
                    fi
                    ;;
                *)
                    if [ "$shouldTrack" = false ] && is_aspire_reference "$skillPath"; then
                        fileReference="$skillPath"
                        eventType="reference_file_read"
                        shouldTrack=true
                    fi
                    ;;
            esac
        fi
    fi
fi

# --- tool_invocation via an Aspire MCP tool prefix ---
# Conservative exact prefixes (avoid matching arbitrary "*aspire*" tools):
#   Copilot: aspire-<tool>   Claude: mcp__aspire__<tool>   VS Code: mcp_aspire_<tool>
case "$toolName" in
    aspire-*)
        mcpTool="${toolName#aspire-}"
        ;;
    mcp__aspire__*)
        mcpTool="${toolName#mcp__aspire__}"
        ;;
    mcp_aspire_*)
        mcpTool="${toolName#mcp_aspire_}"
        ;;
    *)
        mcpTool=""
        ;;
esac
if [ -n "$mcpTool" ] && is_aspire_mcp_tool "$mcpTool"; then
        mcpToolName="$toolName"
        eventType="tool_invocation"
        shouldTrack=true
fi

if [ "$shouldTrack" != true ]; then
    exit 0
fi

# Resolve the Aspire CLI. ASPIRE_CLI_COMMAND lets tests substitute a recording stub.
aspireCmd="${ASPIRE_CLI_COMMAND:-aspire}"

# Build the argument vector explicitly so untrusted hook values are passed as discrete args
# (never concatenated into a shell string).
args=(agent telemetry --event-type "$eventType" --client-name "$clientName" --timestamp "$timestamp")
[ -n "$sessionId" ] && args+=(--session-id "$sessionId")
[ -n "$skillName" ] && args+=(--skill-name "$skillName")
[ -n "$mcpToolName" ] && args+=(--tool-name "$mcpToolName")
[ -n "$fileReference" ] && args+=(--file-reference "$fileReference")

# Run the CLI in its own process group so the timeout can terminate descendants as well as the
# immediate process. Job control is enabled only while starting the child; disabling it again
# prevents background-job notifications from contaminating the hook response.
set -m
"$aspireCmd" "${args[@]}" >/dev/null 2>&1 &
cliPid=$!
set +m

set -m
(
    sleep 10
    kill -TERM -- "-$cliPid" >/dev/null 2>&1
    sleep 1
    kill -KILL -- "-$cliPid" >/dev/null 2>&1
) >/dev/null 2>&1 &
watchdogPid=$!
set +m

wait "$cliPid" >/dev/null 2>&1

# Cancel the timer when the immediate process exits, then clean up any descendant that kept the
# process group alive after its wrapper returned.
exec 3>&2 2>/dev/null
kill -KILL -- "-$watchdogPid" >/dev/null 2>&1
wait "$watchdogPid" >/dev/null 2>&1
kill -KILL -- "-$cliPid" >/dev/null 2>&1
exec 2>&3 3>&-

# Explicit exit 0: the EXIT trap prints the response, but we must not let the CLI's exit code
# leak through as the hook's exit code.
exit 0
