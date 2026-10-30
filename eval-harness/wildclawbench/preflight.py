"""Check model availability and real account credit before any paid task."""

import argparse
import json
from pathlib import Path
import urllib.request


def main():
    manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=manifest["models"])
    parser.add_argument("--credentials", type=Path, required=True)
    args = parser.parse_args()
    from dotenv import dotenv_values

    values = dotenv_values(args.credentials.expanduser())
    for name in ("OPENROUTER_API_KEY", "BRAVE_API_KEY"):
        if not values.get(name):
            raise SystemExit("Credentials file is missing " + name)
    if values.get("JUDGE_MODEL", "openai/gpt-5.4") != "openai/gpt-5.4":
        raise SystemExit("The judge must remain openai/gpt-5.4")

    def read(endpoint):
        request = urllib.request.Request("https://openrouter.ai/api/v1/" + endpoint,
                                        headers={"Authorization": "Bearer " + values["OPENROUTER_API_KEY"]})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)["data"]

    key = read("key")
    credits = read("credits")
    if credits["total_credits"] - credits["total_usage"] <= 0:
        raise SystemExit("OpenRouter account has no available funded credit; an unused key limit does not fund it")
    remaining = key.get("limit_remaining")
    if isinstance(remaining, (int, float)) and remaining <= 0:
        raise SystemExit("The key's spending allowance is exhausted")
    models = {model["id"] for model in read("models")}
    if args.model.removeprefix("openrouter/") not in models:
        raise SystemExit("Requested model is absent from OpenRouter; do not substitute another model")
    print("Preflight passed: account credit, key allowance, required keys, default judge and requested model")
    print("The authorized $60 run budget must be tracked independently of the key's account-wide allowance")


if __name__ == "__main__":
    main()
