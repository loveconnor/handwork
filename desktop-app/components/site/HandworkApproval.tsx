"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import type { Permission } from "@/lib/desktop-state";

type Option = Permission["options"][number];

/** Splits a permission's `key: value` detail lines; a line without a key continues the value above it. */
export function permissionFields(detail: string) {
  const fields: { key: string; value: string }[] = [];
  for (const line of detail.split("\n")) {
    const match = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (match) fields.push({ key: match[1], value: match[2] });
    else if (fields.length) fields[fields.length - 1].value += `\n${line}`;
    else if (line.trim()) fields.push({ key: "", value: line });
  }
  return fields;
}

const DESTRUCTIVE = /\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)|\bsudo\b|--force\b|\bgit\s+push\b[^\n]*\s-f\b|\bdrop\s+(table|database)\b/i;
const HOME = /^\/(?:Users|home)\/[^/\n]+(?=\/|$)/gm;
const COMMAND_KEYS = ["command", "cmd"];
const CWD_KEYS = ["cwd", "workdir", "working_directory"];

/** What the card shows for a permission: a plain heading, the one thing it acts on, and where. */
export function describePermission(permission: Pick<Permission, "title" | "detail">) {
  const fields = permissionFields(permission.detail);
  const command = fields.find(field => COMMAND_KEYS.includes(field.key))?.value.trim();
  const cwd = fields.find(field => CWD_KEYS.includes(field.key))?.value.trim();
  const rest = fields.filter(field => !COMMAND_KEYS.includes(field.key) && !CWD_KEYS.includes(field.key) && field.value.trim());
  const title = permission.title.trim() || "Permission required";
  let body = command;
  if (!body && rest.length) {
    body = rest.length === 1 ? rest[0].value.trim() : rest.map(field => field.key ? `${field.key}: ${field.value}` : field.value).join("\n");
    // A title that already names the target says it once.
    if (rest.length === 1 && title.includes(body)) body = undefined;
    else body = body.replace(HOME, "~");
  }
  const heading = command ? "Run a command" : title;
  const where = cwd ? cwd.replace(HOME, "~") : undefined;
  return { heading, body, where, destructive: DESTRUCTIVE.test(`${command ?? ""}\n${title}\n${body ?? ""}`) };
}

function rank(option: Option) {
  const kind = option.kind ?? "";
  if (kind.startsWith("reject")) return 0;
  if (kind === "allow_once") return 2;
  return 1;
}

/** The one action a person most likely wants, so focus and the filled button land on it. */
function primaryOf(options: Option[]) {
  return options.find(option => option.kind === "allow_once") ?? options.find(option => option.kind?.startsWith("allow")) ?? options[options.length - 1];
}

export function HandworkApproval({ permission, answering, onAnswer }: {
  permission: Permission;
  answering: boolean;
  onAnswer: (optionId: string | null) => void;
}) {
  const headingId = useId();
  const { heading, body, where, destructive } = describePermission(permission);
  const options = [...permission.options].sort((a, b) => rank(a) - rank(b));
  const primary = primaryOf(options);
  return <section className="handwork-approval" data-destructive={destructive || undefined} aria-labelledby={headingId} aria-busy={answering || undefined}>
    <h3 id={headingId} className="handwork-approval-heading">{heading}</h3>
    {body && <pre className="handwork-approval-command"><code>{body}</code></pre>}
    {where && <p className="handwork-approval-where" title={where}>in {where}</p>}
    <div className="handwork-approval-actions">
      {options.length ? options.map(option => {
        const isPrimary = option === primary;
        const variant = isPrimary ? "default" : rank(option) === 0 ? "ghost" : "outline";
        return <Button key={option.optionId} size="sm" variant={variant} data-kind={option.kind} data-primary={isPrimary || undefined}
          disabled={answering} onClick={() => onAnswer(option.optionId)}>{option.name}</Button>;
      }) : <Button size="sm" variant="outline" data-primary disabled={answering} onClick={() => onAnswer(null)}>Dismiss</Button>}
    </div>
  </section>;
}
