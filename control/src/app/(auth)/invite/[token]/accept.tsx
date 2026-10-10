"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/client/api";
import { FormError } from "../../auth-form";

export function AcceptInvite({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <FormError message={err} />
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await api<{ redirect: string }>(`/api/v1/invites/${token}`, { method: "POST" });
            router.push(r.redirect);
            router.refresh();
          } catch (e) {
            setErr(e instanceof ApiClientError ? e.message : "Could not accept the invite");
            setBusy(false);
          }
        }}
      >
        Accept invite
      </Button>
      <p className="text-xs text-subtle">Signed in as {email}</p>
    </>
  );
}
