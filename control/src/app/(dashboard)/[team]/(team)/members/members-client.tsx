"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Link2, MoreHorizontal, UserPlus } from "lucide-react";
import type { TeamRole } from "@prisma/client";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CardBody } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Dialog } from "@/components/ui/dialog";
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/dropdown";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";
import { ROLES, ROLE_HELP, ROLE_LABEL, ROLE_RANK } from "@/lib/auth/roles";
import { timeAgo } from "@/lib/utils";

type Member = { userId: string; name: string; email: string; avatar: string | null; role: TeamRole; joinedAt: string };
type Invite = { id: string; email: string | null; role: TeamRole; expiresAt: string };

export function MembersClient({ team, meId, myRole, members, invites }: { team: string; meId: string; myRole: TeamRole; members: Member[]; invites: Invite[] }) {
  const router = useRouter();
  const toast = useToast();
  const isAdmin = ROLE_RANK[myRole] >= ROLE_RANK.ADMIN;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("MEMBER");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error("Something went wrong", e instanceof ApiClientError ? e.message : undefined);
    }
  };

  return (
    <div className="space-y-6">
      {isAdmin && (
        <Card>
          <CardHeader title="Invite member" description="Create an invite link. Optionally restrict it to an email address (we'll email it if SMTP is configured)." />
          <CardBody>
            <form
              id="invite-form"
              className="grid gap-3 sm:grid-cols-[1fr_180px]"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api<{ url: string }>(`/api/v1/teams/${team}/invites`, { body: { email: email || null, role } });
                  setLink(r.url);
                  setEmail("");
                  router.refresh();
                } catch (e) {
                  toast.error("Could not create invite", e instanceof ApiClientError ? e.message : undefined);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="Email (optional)" htmlFor="invite-email">
                <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" />
              </Field>
              <Field label="Role" htmlFor="invite-role">
                <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as TeamRole)} options={ROLES.filter((r) => r !== "OWNER" || myRole === "OWNER").map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
              </Field>
            </form>
          </CardBody>
          <CardFooter hint={ROLE_HELP[role]}>
            <Button type="submit" form="invite-form" variant="primary" size="sm" loading={busy} leftIcon={<UserPlus className="h-3.5 w-3.5" />}>
              Create invite
            </Button>
          </CardFooter>
        </Card>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border bg-bg-subtle px-5 py-3 text-[13px] font-medium text-muted">{members.length} member{members.length === 1 ? "" : "s"}</div>
        <ul className="divide-y divide-border" data-testid="members-list">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-5 py-3.5">
              <Avatar name={m.name} src={m.avatar} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name} {m.userId === meId && <span className="text-subtle">(you)</span>}
                </p>
                <p className="truncate text-[13px] text-muted">{m.email}</p>
              </div>
              <span className="hidden text-[12px] text-subtle sm:block">joined {timeAgo(m.joinedAt)}</span>
              <Badge tone={m.role === "OWNER" ? "accent" : "neutral"}>{ROLE_LABEL[m.role]}</Badge>
              {(isAdmin || m.userId === meId) && (
                <Dropdown
                  align="end"
                  trigger={() => (
                    <button className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Member actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      {isAdmin && (
                        <>
                          <DropdownLabel>Change role</DropdownLabel>
                          {ROLES.filter((r) => r !== m.role && (myRole === "OWNER" || (r !== "OWNER" && m.role !== "OWNER"))).map((r) => (
                            <DropdownItem
                              key={r}
                              onClick={() => {
                                close();
                                void call(() => api(`/api/v1/teams/${team}/members/${m.userId}`, { method: "PATCH", body: { role: r } }), `Role changed to ${ROLE_LABEL[r]}`);
                              }}
                            >
                              {ROLE_LABEL[r]}
                            </DropdownItem>
                          ))}
                          <DropdownSeparator />
                        </>
                      )}
                      <DropdownItem
                        danger
                        onClick={() => {
                          close();
                          void call(() => api(`/api/v1/teams/${team}/members/${m.userId}`, { method: "DELETE" }), m.userId === meId ? "You left the team" : "Member removed");
                        }}
                      >
                        {m.userId === meId ? "Leave team" : "Remove from team"}
                      </DropdownItem>
                    </>
                  )}
                </Dropdown>
              )}
            </li>
          ))}
        </ul>
      </div>

      {isAdmin && invites.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="border-b border-border bg-bg-subtle px-5 py-3 text-[13px] font-medium text-muted">Pending invites</div>
          <ul className="divide-y divide-border">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-5 py-3">
                <Link2 className="h-4 w-4 text-subtle" />
                <span className="flex-1 truncate text-sm">{i.email ?? "Anyone with the link"}</span>
                <Badge>{ROLE_LABEL[i.role]}</Badge>
                <span className="text-[12px] text-subtle">expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                <Button size="sm" variant="ghost" onClick={() => call(() => api(`/api/v1/teams/${team}/invites/${i.id}`, { method: "DELETE" }), "Invite revoked")}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={!!link} onClose={() => setLink(null)} title="Invite link created" description="Share this link. It's shown only once." footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        {link && <CodeBlock code={link} wrap />}
      </Dialog>
    </div>
  );
}
