"""Supplemental queue-derived delegation regression, outside the six-task pilot."""
import re

KIND = "queue-delegation-regression-v1"
CLASSIFICATION = "queue-derived delegation regression; not a fresh holdout or statistical significance"
ADDENDUM = (
    "\n\nDelegation regression case: use exactly one temporary subagent (subagent action run) "
    "to implement the mapLimit fix in src/map.js. Give it the documented outcome, relevant "
    "API constraints, and exclusive ownership of src/map.js; it must not edit other files "
    "or delegate. You own src/worker.js: fix execute so synchronous throws and asynchronous "
    "rejections become rejected settlement records. Continue that independent work while "
    "the child runs, then integrate its result and run the existing tests. Do not duplicate "
    "the child's implementation. Neither actor may modify tests, README.md, package files "
    "or install dependencies. Return a concise change and verification summary."
)


def schedule():
    return [{"id": f"queue-{pair}-{arm}", "task": "queue", "pair": pair, "arm": arm}
            for pair, arms in ((1, ("baseline", "candidate")), (2, ("candidate", "baseline")))
            for arm in arms]


def configure(configuration):
    original = configuration["tasks"]["queue"]
    return dict(configuration, original_queue_contract=original,
                tasks={"queue": dict(original, prompt=original["prompt"] + ADDENDUM)})


def verify(manifest):
    config = manifest["configuration"]
    expected = dict(config["original_queue_contract"],
                    prompt=config["original_queue_contract"]["prompt"] + ADDENDUM)
    if config["tasks"] != {"queue": expected} or manifest["schedule"] != schedule():
        raise ValueError("supplemental delegation contract or schedule mismatch")
    if manifest["candidate_controls"] != {"HANDWORK_EXPERIMENT_BOUNDED_DELEGATION": "1"}:
        raise ValueError("supplemental delegation requires its single feature flag")


def evidence(trace, arm):
    """Require admitted child work and the actual child-only policy delivery."""
    identities = set()
    for line in trace.splitlines():
        fields = dict(re.findall(r"\b([a-z_]+)=([^\s]+)", line))
        if fields.get("event") == "provider_admitted" and fields.get("subagent_id", "0") != "0":
            identities.add(fields["subagent_id"])
    problems = []
    if len(identities) != 1 or not all(value.isascii() and value.isdecimal() for value in identities):
        problems.append("supplemental case requires exactly one admitted child identity")
    child_events = re.findall(r"event=bounded_delegation subagent_id=([1-9][0-9]*) "
                             r"enabled=(true|false) available=(true|false) "
                             r"guidance_bytes=(\d+) child_policy_bytes=(\d+)\b", trace)
    enabled = arm == "candidate"
    if ({event[0] for event in child_events} != identities or not child_events or
            any(flag != str(enabled).lower() or available != "false" or
                (int(size) > 0) != enabled or size != policy
                for _, flag, available, size, policy in child_events)):
        problems.append("supplemental child reporting policy missing or mismatched")
    return {"child_ids": sorted(identities), "problems": problems}
