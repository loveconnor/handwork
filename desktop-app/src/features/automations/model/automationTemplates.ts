import type {
  AutomationScheduleKind,
  AutomationTriggerKind,
} from "./automations";
export const AUTOMATION_TEMPLATE_CATEGORIES = [
  { id: "popular", label: "Popular" },
  { id: "review", label: "Code review" },
  { id: "security", label: "Security" },
  { id: "incidents", label: "Incidents and triage" },
  { id: "research", label: "Data and research" },
  { id: "environment", label: "Environment" },
] as const;
export type AutomationTemplateCategoryId =
  (typeof AUTOMATION_TEMPLATE_CATEGORIES)[number]["id"];
export type AutomationTemplateIcon =
  | "search"
  | "alert"
  | "file"
  | "check"
  | "lock"
  | "pr"
  | "gauge"
  | "terminal"
  | "note";
export type AutomationTemplate = {
  id: string;
  category: Exclude<AutomationTemplateCategoryId, "popular">;
  popular?: boolean;
  icon: AutomationTemplateIcon;
  name: string;
  description: string;
  prompt: string;
  trigger: {
    kind: AutomationTriggerKind;
    event: string;
    scheduleKind?: AutomationScheduleKind;
    time?: string;
    dayOfWeek?: number;
    minute?: number;
  };
  triggerLabel: string;
};
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "find-critical-bugs",
    category: "review",
    popular: true,
    icon: "alert",
    name: "Find critical bugs",
    description:
      "Find serious bugs in recent commits and fix them when the change is safe.",
    trigger: {
      kind: "time",
      event: "weekdays",
      scheduleKind: "weekdays",
      time: "09:00",
    },
    triggerLabel: "Weekdays at 09:00",
    prompt: `Review recent commits for serious bugs, including logic errors, race conditions, data loss, and failed error handling.

Report only bugs you can confirm in the current code. Include the affected file and explain the failure. Fix a bug only when the change is safe and local. Leave style changes and unconfirmed concerns out of the report.

Summarize the bugs found, fixes made, and any work that needs human review.`,
  },
  {
    id: "scan-vulnerabilities",
    category: "security",
    popular: true,
    icon: "search",
    name: "Find security vulnerabilities",
    description:
      "Review the repository for security issues and report confirmed risks.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "10:00",
      dayOfWeek: 1,
    },
    triggerLabel: "Monday at 10:00",
    prompt: `Review this repository for security vulnerabilities.

Check for injection attacks, XSS, SSRF, broken authentication or authorization, exposed credentials, unsafe deserialization, path traversal, and risky dependencies or configuration.

Report only issues supported by evidence in the code. Do not invent CVEs. For each finding, include its impact, file path, how an attacker could exploit it, and a recommended fix. Apply a fix only when it is safe and local.`,
  },
  {
    id: "generate-docs",
    category: "research",
    popular: true,
    icon: "file",
    name: "Update documentation",
    description:
      "Update documentation for changed code and missing setup steps.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "09:00",
      dayOfWeek: 1,
    },
    triggerLabel: "Monday at 09:00",
    prompt: `Update developer documentation to match recent code changes.

Look for new or renamed APIs, modules, and workflows that need documentation. Edit existing documents where possible. Add missing setup steps, run commands, and entry points. Describe only behavior you can confirm in the code.

Summarize which documents you changed and why.`,
  },
  {
    id: "add-test-coverage",
    category: "review",
    popular: true,
    icon: "check",
    name: "Add test coverage",
    description:
      "Add tests for recent changes where failures could cause serious bugs.",
    trigger: {
      kind: "time",
      event: "weekdays",
      scheduleKind: "weekdays",
      time: "11:00",
    },
    triggerLabel: "Weekdays at 11:00",
    prompt: `Review recent commits and add missing tests for code where a failure could cause a serious bug.

Use the project's existing test runner and style. Test behavior, edge cases, and regressions. Change production code only if a test reveals a confirmed bug. Run the relevant tests and fix failures caused by your changes.

Summarize the tests added and any gaps that remain.`,
  },
  {
    id: "dependency-audit",
    category: "security",
    icon: "lock",
    name: "Audit dependencies",
    description:
      "Check dependencies for security risks, unused packages, and unexpected upgrades.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "09:30",
      dayOfWeek: 1,
    },
    triggerLabel: "Monday at 09:30",
    prompt: `Review package manifests and lockfiles for vulnerable, unused, abandoned, or unexpectedly upgraded dependencies.

Confirm findings with the project's package tools. Explain the reason for each proposed upgrade or removal. Make a major-version upgrade only if the current version is unsafe and the upgrade is required.

Report confirmed risks, changes made, and anything that needs human review.`,
  },
  {
    id: "secret-scan",
    category: "security",
    icon: "lock",
    name: "Scan for secrets",
    description:
      "Find exposed API keys, tokens, and passwords in files and recent commits.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "09:30",
      dayOfWeek: 1,
    },
    triggerLabel: "Monday at 09:30",
    prompt: `Scan project files and recent Git history for exposed secrets, including API keys, tokens, private keys, passwords, and credentials in configuration files.

Do not print complete secret values. For each confirmed secret, report the file path and a redacted excerpt. Explain the risk and recommend replacing the credential. If it was committed, also recommend removing it from Git history.`,
  },
  {
    id: "failing-ci-watch",
    category: "incidents",
    icon: "alert",
    name: "Check for failing tests",
    description:
      "Run the project's checks on weekday mornings and investigate failures.",
    trigger: {
      kind: "time",
      event: "weekdays",
      scheduleKind: "weekdays",
      time: "08:30",
    },
    triggerLabel: "Weekdays at 08:30",
    prompt: `Run the project's existing tests, lint checks, and type checks.

If a check fails, find the first cause. Fix it only if the cause is clear and local. Otherwise, report the failing command, error, and likely source file.

Use the existing test setup. Keep assertions that detect failures, including intermittent failures.`,
  },
  {
    id: "weekly-changelog",
    category: "research",
    icon: "note",
    name: "Weekly changelog",
    description:
      "Summarize the past week's changes, fixes, and internal work.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "16:00",
      dayOfWeek: 5,
    },
    triggerLabel: "Friday at 16:00",
    prompt: `Write a changelog for the past seven days of commits.

Group entries by user-facing changes, fixes, and internal work. Omit formatting-only changes, lockfile-only changes, and merge commits. Use the project's changelog format if it has one. Otherwise, write a short Markdown summary.

Include only changes supported by the commits.`,
  },
  {
    id: "repo-health",
    category: "environment",
    icon: "gauge",
    name: "Check repository setup",
    description:
      "Check for outdated setup instructions, broken scripts, and configuration problems.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "09:00",
      dayOfWeek: 1,
    },
    triggerLabel: "Monday at 09:00",
    prompt: `Check the repository setup for problems.

Look for build output that should be ignored by Git, outdated README or setup steps, CI and type-check configuration that no longer matches the project, and broken commands in package.json, Makefile, or justfile.

Fix small issues when the correct change is clear. Report other issues with file paths. Keep changes limited to setup and configuration.`,
  },
  {
    id: "install-doctor",
    category: "environment",
    icon: "terminal",
    name: "Check installation",
    description:
      "Follow the documented setup steps and check that the project starts.",
    trigger: {
      kind: "time",
      event: "weekly",
      scheduleKind: "weekly",
      time: "10:00",
      dayOfWeek: 1,
    },
    triggerLabel: "Monday at 10:00",
    prompt: `Check that the project installs and starts from a clean working copy.

Follow the documented setup steps. Record missing prerequisites, broken commands, and instructions that do not match the project. Fix small documentation or script errors. Keep the application architecture unchanged.

Report whether setup passed and list the exact commands you ran.`,
  },
];
export function templatesForCategory(
  category: AutomationTemplateCategoryId,
): AutomationTemplate[] {
  if (category === "popular") {
    return AUTOMATION_TEMPLATES.filter(
      (template) => template.popular && template.trigger.kind === "time",
    );
  }
  return AUTOMATION_TEMPLATES.filter(
    (template) =>
      template.category === category && template.trigger.kind === "time",
  );
}
