import json
import os
from pathlib import Path

import boto3
import requests
import websocket
from botocore.config import Config


settings = json.loads(Path(__file__).with_name("settings.json").read_text())


def fetch_catalog():
    """Product lookup uses the existing authenticated HTTPS transport."""
    with requests.Session() as client:
        client.headers["Authorization"] = f"Bearer {os.environ['CATALOG_TOKEN']}"
        response = client.get(
            f"{settings['catalogBaseUrl']}/items",
            verify=os.environ["PROVIDER_CA_BUNDLE"],
            timeout=10,
        )
        response.raise_for_status()
        return response.json()


def watch_updates(on_update):
    """The stream client regenerates auth headers on reconnect and owns recovery."""
    client = websocket.WebSocketApp(
        settings["streamUrl"],
        header=lambda: {"Authorization": f"Bearer {os.environ['STREAM_TOKEN']}"},
        on_message=lambda connection, message: on_update(json.loads(message)),
    )
    client.run_forever(
        reconnect=5,
        sslopt={"ca_certs": os.environ["PROVIDER_CA_BUNDLE"]},
    )


def archive_snapshot(bucket, key, payload):
    """The SDK selects endpoints and credentials; retain its TLS and retries."""
    client = boto3.client(
        "s3",
        region_name=settings["storageRegion"],
        verify=os.environ["PROVIDER_CA_BUNDLE"],
        config=Config(retries={"mode": "adaptive", "max_attempts": 4}),
    )
    client.put_object(Bucket=bucket, Key=key, Body=payload)


if __name__ == "__main__":
    bucket = os.environ["ARCHIVE_BUCKET"]
    archive_snapshot(bucket, "catalog.json", json.dumps(fetch_catalog()).encode())
    watch_updates(
        lambda update: archive_snapshot(bucket, "latest.json", json.dumps(update).encode())
    )
