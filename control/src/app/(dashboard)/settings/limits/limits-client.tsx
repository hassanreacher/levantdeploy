"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import type { PlatformOverview } from "@/lib/ops/platform";
import { usePlatformPatch } from "../save-helper";

const num = (s: string) => (s.trim() === "" ? null : Number(s));

export function LimitsSettings({ limits: l }: { limits: PlatformOverview["limits"] }) {
  const { busy, patch } = usePlatformPatch();
  const [concurrency, setConcurrency] = useState(String(l.buildConcurrency));
  const [timeout, setTimeout_] = useState(String(l.buildTimeoutMinutes));
  const [upload, setUpload] = useState(String(l.uploadMaxSizeMb));
  const [cpu, setCpu] = useState(l.defaults.cpuLimit === null ? "" : String(l.defaults.cpuLimit));
  const [mem, setMem] = useState(l.defaults.memoryLimitMb === null ? "" : String(l.defaults.memoryLimitMb));
  const [replicas, setReplicas] = useState(String(l.defaults.maxReplicas));

  const buildDirty = Number(concurrency) !== l.buildConcurrency || Number(timeout) !== l.buildTimeoutMinutes;
  const runtimeDirty = num(cpu) !== l.defaults.cpuLimit || num(mem) !== l.defaults.memoryLimitMb || Number(replicas) !== l.defaults.maxReplicas;

  return (
    <>
      <Card>
        <CardHeader title="Builds" description="How many builds run at the same time and how long one may take before it is canceled." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Concurrent builds" htmlFor="concurrency" hint="1–16. Each build uses CPU and memory; 2 suits a 4 GB server.">
            <Input id="concurrency" type="number" min={1} max={16} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
          <Field label="Build timeout" htmlFor="timeout" hint="1–240 minutes.">
            <Input id="timeout" type="number" min={1} max={240} value={timeout} onChange={(e) => setTimeout_(e.target.value)} suffix="min" />
          </Field>
        </CardBody>
        <CardFooter hint="Concurrency changes apply when the worker restarts.">
          <Button size="sm" variant="primary" disabled={!buildDirty} loading={busy === "build"} onClick={() => patch("build", { buildConcurrency: Number(concurrency), buildTimeoutMinutes: Number(timeout) })}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Uploads" description="Maximum size of a source upload from the CLI (levant deploy) or the dashboard." />
        <CardBody>
          <Field label="Max upload size" htmlFor="upload" hint="1–2047 MB. .gitignore'd files and node_modules are never uploaded.">
            <Input id="upload" type="number" min={1} max={2047} value={upload} onChange={(e) => setUpload(e.target.value)} suffix="MB" className="max-w-[200px]" />
          </Field>
        </CardBody>
        <CardFooter>
          <Button size="sm" variant="primary" disabled={Number(upload) === l.uploadMaxSizeMb} loading={busy === "upload"} onClick={() => patch("upload", { uploadMaxSizeMb: Number(upload) })}>
            Save
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="Default Container Limits" description="Applied to new projects. Each project can override them in its runtime settings." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="CPU" htmlFor="cpu" hint="Cores, empty = unlimited.">
            <Input id="cpu" type="number" step="0.25" min={0.25} value={cpu} onChange={(e) => setCpu(e.target.value)} placeholder="unlimited" suffix="vCPU" />
          </Field>
          <Field label="Memory" htmlFor="mem" hint="Empty = unlimited.">
            <Input id="mem" type="number" min={16} value={mem} onChange={(e) => setMem(e.target.value)} placeholder="unlimited" suffix="MB" />
          </Field>
          <Field label="Max replicas" htmlFor="replicas" hint="Per project.">
            <Input id="replicas" type="number" min={1} max={64} value={replicas} onChange={(e) => setReplicas(e.target.value)} />
          </Field>
        </CardBody>
        <CardFooter hint="Containers that exceed their memory limit are restarted.">
          <Button
            size="sm"
            variant="primary"
            disabled={!runtimeDirty}
            loading={busy === "defaults"}
            onClick={() => patch("defaults", { defaults: { cpuLimit: num(cpu), memoryLimitMb: num(mem), maxReplicas: Number(replicas) } })}
          >
            Save
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}
