"""PII redaction script using a local llama.cpp server.

Sends text to the Distil-PII model running on 127.0.0.1:8712 and prints only
redacted text by default. Uses only the Python standard library.
"""

import argparse
import json
import os
from ipaddress import ip_address
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_SERVER_URL = os.environ.get(
    "DISTIL_PII_SERVER_URL",
    "http://127.0.0.1:8712/v1/chat/completions",
)
DEFAULT_MODEL = os.environ.get("DISTIL_PII_MODEL", "distil-pii")
DEFAULT_TIMEOUT_SECONDS = float(os.environ.get("DISTIL_PII_TIMEOUT", "120"))
FALLBACK_RESPONSE_FORMAT_STATUSES = {400, 422}

SYSTEM_PROMPT = """\
You are a problem solving model working on task_description XML block:
<task_description>
Produce a redacted version of texts, removing sensitive personal data while preserving operational signals. The model must return a single json blob with:

* **redacted_text** is the input with minimal, in-place replacements of redacted entities.
* **entities** as an array of objects with exactly three fields {value: original_value, replacement_token: replacement, reason: reasoning}.

## What to redact (-> replacement token)

* **PERSON** -- customer/patient/person names (first/last/full; identifying initials) -> `[PERSON]`
* **EMAIL** -- any email, including obfuscated `name(at)domain(dot)com` -> `[EMAIL]`
* **PHONE** -- any international/national format (separators/emoji bullets allowed) -> `[PHONE]`
* **ADDRESS** -- street + number; full postal lines; apartment/unit numbers -> `[ADDRESS]`
* **SSN** -- US Social Security numbers -> `[SSN]`
* **ID** -- national IDs (PESEL, NIN, Aadhaar, DNI, etc.) when personal -> `[ID]`
* **UUID** -- person-scoped system identifiers (e.g., MRN/NHS/patient IDs/customer UUIDs) -> `[UUID]`
* **CREDIT_CARD** -- 13-19 digits (spaces/hyphens allowed) -> `[CARD_LAST4:####]` (keep last-4 only)
* **IBAN** -- IBAN/bank account numbers -> `[IBAN_LAST4:####]` (keep last-4 only)
* **GENDER** -- self-identification (male/female/non-binary/etc.) -> `[GENDER]`
* **AGE** -- stated ages ("I'm 29", "age: 47", "29 y/o") -> `[AGE_YEARS:##]`
* **RACE** -- race/ethnicity self-identification -> `[RACE]`
* **MARITAL_STATUS** -- married/single/divorced/widowed/partnered -> `[MARITAL_STATUS]`

## Keep (do not redact)

* Card **last-4** when only last-4 is present (e.g., "ending 9021").
* Operational IDs: order/ticket/invoice numbers, shipment tracking, device serials, case IDs.
* Non-personal org info: company names, product names, team names.
* Cities/countries alone (redact full street+number, not plain city/country mentions).

## Output schema (exactly these fields)
* **redacted_text** The original text with all the sensitive information replaced with redacted tokens
* **entities** Array with all the replaced elements, each element represented by following fields
  * **replacement_token**: one of [PERSON] | [EMAIL] | [PHONE] | [ADDRESS] | [SSN] | [ID] | [UUID] | [CARD_LAST4:####] | [IBAN_LAST4:####] | [GENDER] | [AGE_YEARS:##] | [RACE] | [MARITAL_STATUS]
  * **value**: original text that was redacted
  * **reason**: brief string explaining the rule/rationale
</task_description>
You will be given a single task with context in the context XML block and the task in the question XML block
Solve the task in question block based on the context in context block.
Generate only the answer, do not generate anything else"""

USER_PROMPT_TEMPLATE = """\
Now for the real task, solve the task in question block based on the context in context block.
Generate only the solution, do not generate anything else
<context>
{text}
</context>
<question>Redact provided text according to the task description and return redacted elements.</question>"""

JSON_SCHEMA_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "pii_redaction",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "redacted_text": {"type": "string"},
                "entities": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"},
                            "replacement_token": {"type": "string"},
                            "reason": {"type": "string"},
                        },
                        "required": ["value", "replacement_token", "reason"],
                    },
                },
            },
            "required": ["redacted_text", "entities"],
        },
    },
}

JSON_OBJECT_RESPONSE_FORMAT = {"type": "json_object"}


def main(
    text: str,
    show_entities: bool = False,
    server_url: str = DEFAULT_SERVER_URL,
    model: str = DEFAULT_MODEL,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    output_file: str | None = None,
    allow_remote: bool = False,
):
    """Send text to the local Distil-PII model and emit redacted output."""
    validate_server_url(server_url, allow_remote=allow_remote)
    result = request_redaction(
        text=text,
        server_url=server_url,
        model=model,
        timeout=timeout,
    )

    content = extract_message_content(result)
    output = content if show_entities else extract_redacted_text(content)

    if output_file:
        write_output_file(output_file, output)
    else:
        print(output)


def request_redaction(
    text: str,
    server_url: str,
    model: str,
    timeout: float,
) -> dict:
    try:
        return post_redaction_request(
            text=text,
            server_url=server_url,
            model=model,
            timeout=timeout,
            response_format=JSON_SCHEMA_RESPONSE_FORMAT,
        )
    except urllib.error.HTTPError as error:
        if error.code not in FALLBACK_RESPONSE_FORMAT_STATUSES:
            fail_http_error(error)

    try:
        return post_redaction_request(
            text=text,
            server_url=server_url,
            model=model,
            timeout=timeout,
            response_format=JSON_OBJECT_RESPONSE_FORMAT,
        )
    except urllib.error.HTTPError as error:
        fail_http_error(error)


def post_redaction_request(
    text: str,
    server_url: str,
    model: str,
    timeout: float,
    response_format: dict,
) -> dict:
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT_TEMPLATE.format(text=text)},
        ],
        "temperature": 0,
        "response_format": response_format,
    }).encode()

    req = urllib.request.Request(
        server_url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError:
        fail(
            f"Could not connect to llama-server at {server_url}.\n"
            "Run 'bash skills/distil-pii-redactor/scripts/setup.sh' first to "
            "download the model and start the server."
        )
    except json.JSONDecodeError:
        fail("llama-server returned a non-JSON response.")


def fail_http_error(error: urllib.error.HTTPError) -> None:
    fail(
        f"llama-server returned HTTP {error.code}. "
        "Response body omitted to avoid exposing source text."
    )


def extract_message_content(result: dict) -> str:
    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        fail("llama-server returned an unexpected response shape.")

    if not isinstance(content, str):
        fail("llama-server returned non-text message content.")

    return content


def extract_redacted_text(content: str) -> str:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        fail("llama-server returned non-JSON redaction content.")
    try:
        output = parsed["redacted_text"]
    except (KeyError, TypeError):
        fail("llama-server response did not include redacted_text.")
    if not isinstance(output, str):
        fail("llama-server returned non-text redacted_text.")

    return output


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def validate_server_url(server_url: str, allow_remote: bool = False) -> None:
    parsed = urllib.parse.urlparse(server_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        fail("--server-url must be an http(s) URL with a host.")

    if allow_remote:
        return

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost":
        return

    try:
        address = ip_address(hostname)
    except ValueError:
        fail(
            "--server-url must point to localhost, 127.0.0.0/8, or ::1 by "
            "default. Re-run with --unsafe-allow-remote only for an explicitly "
            "trusted endpoint."
        )

    if address.is_loopback:
        return

    fail(
        "--server-url must point to a loopback address by default. Re-run with "
        "--unsafe-allow-remote only for an explicitly trusted endpoint."
    )


def write_output_file(output_file: str, output: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    with os.fdopen(os.open(output_file, flags, 0o600), "w", encoding="utf-8") as fh:
        fh.write(output)


def read_input_text(args: argparse.Namespace) -> str:
    explicit_sources = sum(
        1 for has_source in [bool(args.input_file), bool(args.text)] if has_source
    )
    if explicit_sources > 1:
        print(
            "ERROR: Provide text via exactly one source: --input-file, argv, or stdin.",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.input_file:
        return Path(args.input_file).read_text(encoding="utf-8")
    if args.text:
        return " ".join(args.text)
    if not sys.stdin.isatty():
        return sys.stdin.read()

    return ""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Redact PII from text using a local Distil-PII model."
    )
    parser.add_argument("text", nargs="*", help="Text to redact (or pipe via stdin)")
    parser.add_argument("--input-file", help="Read text from a UTF-8 file")
    parser.add_argument("--output-file", help="Write output to a UTF-8 file")
    parser.add_argument(
        "--show-entities",
        action="store_true",
        help="Output full JSON with entities (default: redacted text only)",
    )
    parser.add_argument("--server-url", default=DEFAULT_SERVER_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument(
        "--unsafe-allow-remote",
        action="store_true",
        help="Allow sending raw text to a non-loopback server URL",
    )
    args = parser.parse_args()

    input_text = read_input_text(args)
    if not input_text:
        parser.print_usage(sys.stderr)
        print("ERROR: No text provided.", file=sys.stderr)
        sys.exit(1)

    main(
        text=input_text,
        show_entities=args.show_entities,
        server_url=args.server_url,
        model=args.model,
        timeout=args.timeout,
        output_file=args.output_file,
        allow_remote=args.unsafe_allow_remote,
    )
