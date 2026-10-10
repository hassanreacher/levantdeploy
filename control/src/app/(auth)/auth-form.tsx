"use client";

import type { ReactNode } from "react";

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="mb-8 text-center">
      <h1 className="text-[28px] font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger" role="alert">{message}</div>;
}
