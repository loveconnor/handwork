# Public benchmark integration

`harbor_agent.py` connects the native Handwork CLI to Harbor's installed-agent API. It uploads a user-supplied Linux ELF build, writes model/provider/effort settings inside the disposable container, invokes the native CLI, retains JSON/error logs, and imports available token counters. It passes model IDs verbatim. It does not substitute the official provider engine or copy host subscription credentials.

The local machine has a Docker CLI, but `docker info` failed because the daemon was unavailable. The published Handwork npm binary is macOS arm64, not a Linux container executable. A working container engine, a tested Linux Handwork build for the task image's architecture, Harbor, and the selected API credentials are prerequisites. The adapter is not evidence of a completed public evaluation.

Once those prerequisites are available, run a single task smoke test before the dataset. From the repository root:

```sh
PYTHONPATH=benchmarks/harness-efficiency harbor run \
  -t /absolute/path/to/a/harbor/task \
  -a harbor_agent:HandworkAgent \
  --model '<exact-model-id>' \
  --agent-kwarg binary_path=/absolute/path/to/linux/handwork \
  --agent-kwarg provider_id=openai \
  --agent-kwarg effort=low \
  --agent-env OPENAI_API_KEY="$OPENAI_API_KEY"
```

Then use a pinned dataset identifier with `-d` instead of `-t`, following that dataset's official resource, timeout, attempt-count, and submission rules. Pin Harbor and archive its version alongside the dataset version and the binary hash. Run the baseline and candidate under the same API model, reasoning, resources, and budgets. Do not compare this API route with historical subscription timings as if they were controlled pairs.

The adapter targets the installed-agent API documented at https://docs.harborframework.com/core-concepts/agents/custom-agents and inspected in https://github.com/harbor-framework/harbor/tree/main/src/harbor/agents/installed on September 18, 2026. Its dependency-contract checks do not replace a container integration test. No official SWE-bench or Terminal-Bench score is claimed by this change.
