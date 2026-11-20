// The mock records this effect without executing package scripts.
import { writeFileSync } from "node:fs";
writeFileSync("lifecycle-marker.txt", "postinstall ran\n");
