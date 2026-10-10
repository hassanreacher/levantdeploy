"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, Dialog, Input } from "@/components/ui";

/** Destructive confirmation: the user must type `expected` (project name). */
export function TypedConfirmDialog({
  open,
  onClose,
  title,
  description,
  expected,
  action,
  onConfirm,
  busy,
  danger = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  expected: string;
  action: string;
  onConfirm: (typed: string) => void | Promise<void>;
  busy?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      description={description}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant={danger ? "danger" : "primary"} disabled={typed.trim() !== expected} loading={busy} onClick={() => onConfirm(typed.trim())}>
            {action}
          </Button>
        </>
      }
    >
      {children}
      <label className="block">
        <span className="mb-1.5 block text-[13px] text-muted">
          Type <span className="font-mono font-medium text-fg">{expected}</span> to confirm.
        </span>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" aria-label="Confirmation" />
      </label>
    </Dialog>
  );
}
