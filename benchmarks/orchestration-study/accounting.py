"""Strict reconciliation of opt-in context-usage traces, not billing counters."""
import re

FIELDS = ("input", "output", "cached")
PURPOSES = ("generation", "compaction", "image")


def reconcile(text):
    starts, admissions, terminals = {}, {}, {}
    errors = []
    for line in text.splitlines():
        match = re.search(r"\bevent=(request_attempt_started|provider_admitted|request_accounting)\b", line)
        if not match:
            continue
        fields = {}
        for key, value in re.findall(r"\b([a-z_]+)=([^\s]+)", line):
            if key in fields:
                errors.append("duplicate field " + key)
            fields[key] = value
        request_id = fields.get("request_id", "")
        if not request_id.isascii() or not request_id.isdecimal() or int(request_id) < 1:
            errors.append("missing or invalid request_id")
            continue
        request_id = int(request_id)
        table = {"request_attempt_started": starts, "provider_admitted": admissions,
                 "request_accounting": terminals}[match.group(1)]
        if request_id in table:
            errors.append("duplicate " + match.group(1) + " " + str(request_id))
        table[request_id] = fields
    if not starts:
        errors.append("no request starts")
    if not admissions:
        errors.append("no admitted requests")
    if set(starts) != set(terminals):
        errors.append("starts and terminals differ")
    if not set(admissions) <= set(starts):
        errors.append("orphan admission")
    totals = dict.fromkeys(FIELDS, 0)
    root = dict.fromkeys(FIELDS, 0)
    children = dict.fromkeys(FIELDS, 0)
    purposes = {purpose: dict.fromkeys((*FIELDS, "uncached", "admitted_requests"), 0)
                for purpose in PURPOSES}
    for request_id, fields in starts.items():
        if fields.get("purpose") not in PURPOSES:
            errors.append("missing or invalid start purpose " + str(request_id))
    for request_id, fields in terminals.items():
        def boolean(key):
            value = fields.get(key)
            if value not in ("true", "false"):
                errors.append("invalid " + key + " " + str(request_id))
            return value == "true"

        purpose = fields.get("purpose")
        if purpose not in PURPOSES:
            errors.append("missing or invalid terminal purpose " + str(request_id))
        if purpose != starts.get(request_id, {}).get("purpose"):
            errors.append("request purpose mismatch " + str(request_id))
        admitted = boolean("admitted")
        boolean("possibly_sent")
        if admitted != (request_id in admissions):
            errors.append("admission mismatch " + str(request_id))
        if fields.get("status") != "completed":
            errors.append("failed request " + str(request_id))
        consistent = boolean("consistent")
        known = [boolean(key) for key in ("input_known", "output_known", "cache_known")]
        values = {}
        for key in (*FIELDS, "elapsed_ms"):
            raw = fields.get(key, "")
            if not raw.isascii() or not raw.isdecimal():
                errors.append("invalid " + key + " " + str(request_id))
            else:
                values[key] = int(raw)
        if not all(known) or not consistent:
            errors.append("unavailable or inconsistent usage " + str(request_id))
        if "input" in values and "cached" in values and values["cached"] > values["input"]:
            errors.append("cache exceeds input " + str(request_id))
        identity = starts.get(request_id, {}).get("subagent_id", "0")
        if not identity.isascii() or not identity.isdecimal():
            errors.append("invalid child identity " + str(request_id))
        for event in (fields, admissions.get(request_id, {})):
            if event.get("subagent_id", "0") != identity:
                errors.append("child identity mismatch " + str(request_id))
        if admitted and all(known) and consistent and all(key in values for key in FIELDS):
            group = root if identity == "0" else children
            for key in FIELDS:
                totals[key] += values[key]
                group[key] += values[key]
            if purpose in PURPOSES:
                purposes[purpose]["admitted_requests"] += 1
                for key in FIELDS:
                    purposes[purpose][key] += values[key]
                purposes[purpose]["uncached"] += values["input"] - values["cached"]
    eligible = not errors
    return {"eligible": eligible, "errors": errors, "starts": len(starts),
            "admitted_requests": len(admissions), "terminal_records": len(terminals),
            "usage": dict(totals, uncached=totals["input"] - totals["cached"]) if eligible else None,
            "root_usage": root if eligible else None, "child_usage": children if eligible else None,
            "purpose_usage": purposes if eligible else None,
            "counter_kind": "provider context usage, not authoritative billing"}
