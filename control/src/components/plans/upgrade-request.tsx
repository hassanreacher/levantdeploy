"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

/** "Request upgrade" → POST /api/v1/teams/:team/plan/upgrade-request (notifies the platform owner). */
export function UpgradeRequest({ team, options, pending }: { team: string; options: { slug: string; name: string; priceMonthly: number | null }[]; pending: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState(options[0]?.slug ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/teams/${team}/plan/upgrade-request`, { body: { plan: plan || null, message: message || null } });
      toast.success("Upgrade requested", "The platform owner has been notified.");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error("Could not send the request", e instanceof ApiClientError ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)} data-testid="upgrade-request">
        {pending ? "Update request" : "Request upgrade"}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Request a plan upgrade"
        description="Payments aren't enabled on this server yet — the platform owner reviews requests and assigns plans."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={submit}>
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Plan" htmlFor="plan">
            <Select
              id="plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              options={options.map((o) => ({ value: o.slug, label: `${o.name}${o.priceMonthly ? ` — $${o.priceMonthly}/mo` : ""}` }))}
            />
          </Field>
          <Field label="Message (optional)" htmlFor="msg" hint="What do you need more of?">
            <Textarea id="msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
