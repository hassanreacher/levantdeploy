"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Play, Rocket, Trash2 } from "lucide-react";
import { javascript } from "@codemirror/lang-javascript";
import { Badge, Button, Card, CardBody, CardHeader, Input, LogViewer, Select, Skeleton, Switch, Tabs, Textarea, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import type { FunctionDTO } from "@/lib/base-ui/shared";
import { cn } from "@/lib/utils";
import { TypedConfirmDialog } from "./confirm-dialog";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false, loading: () => <Skeleton className="h-[460px] w-full rounded-none" /> });

const errMsg = (e: unknown) => (e instanceof ApiClientError ? (e.fields ? Object.values(e.fields)[0] : e.message) : undefined);

function useIsDark() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const read = () => setDark(!document.documentElement.classList.contains("light"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

type InvokeResult = { status: number; headers: Record<string, string>; body: string; durationMs: number };

export function FunctionEditor({
  refId,
  basePath,
  fn,
  initialCode,
  canUse,
  canUseServiceKey,
  running,
}: {
  refId: string;
  basePath: string;
  fn: FunctionDTO;
  initialCode: string;
  canUse: boolean;
  canUseServiceKey: boolean;
  running: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const dark = useIsDark();
  const [code, setCode] = useState(initialCode);
  const [saved, setSaved] = useState(initialCode);
  const [verifyJwt, setVerifyJwt] = useState(fn.verifyJwt);
  const [version, setVersion] = useState(fn.version);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"invoke" | "logs">("invoke");
  const [del, setDel] = useState(false);
  // invoke tester
  const [method, setMethod] = useState("POST");
  const [auth, setAuth] = useState<"anon" | "service_role" | "none">("anon");
  const [reqBody, setReqBody] = useState('{ "name": "LevantBase" }');
  const [result, setResult] = useState<InvokeResult | null>(null);
  const extensions = useMemo(() => [javascript({ typescript: true })], []);
  const dirty = code !== saved || verifyJwt !== fn.verifyJwt;
  const p = `/api/v1/base/projects/${refId}/functions/${fn.slug}`;

  const deploy = async () => {
    setBusy("deploy");
    try {
      const r = await api<{ function: FunctionDTO }>(p, { method: "PATCH", body: { code, verifyJwt } });
      setSaved(code);
      setVersion(r.function.version);
      toast.success(`Deployed v${r.function.version}`);
      router.refresh();
    } catch (e) {
      toast.error("Deploy failed", errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  // ⌘S / Ctrl+S deploys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (canUse && running && dirty && busy !== "deploy") void deploy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const invoke = async () => {
    setBusy("invoke");
    setResult(null);
    try {
      setResult(await api<InvokeResult>(`${p}/invoke`, { body: { method, auth, body: method === "GET" ? undefined : reqBody, headers: { "content-type": "application/json" } } }));
    } catch (e) {
      toast.error("Invocation failed", errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  let pretty = result?.body ?? "";
  try {
    pretty = JSON.stringify(JSON.parse(pretty), null, 2);
  } catch {}

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="font-mono text-[13px]">index.ts</span>
          <Badge tone="outline">v{version}</Badge>
          {dirty && <Badge tone="warning">unsaved</Badge>}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Verify JWT
              <Switch size="sm" checked={verifyJwt} onCheckedChange={setVerifyJwt} disabled={!canUse} label="Verify JWT" />
            </label>
            {canUse && (
              <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDel(true)}>
                Delete
              </Button>
            )}
            <Button size="sm" variant="primary" leftIcon={<Rocket className="h-3.5 w-3.5" />} disabled={!canUse || !running || !dirty} loading={busy === "deploy"} onClick={deploy} title="⌘S">
              Deploy
            </Button>
          </div>
        </div>
        {canUse ? (
          <div className="min-w-0 max-w-full overflow-hidden text-[13px] [&_.cm-editor]:min-h-[460px] [&_.cm-editor]:outline-none [&_.cm-gutters]:border-r [&_.cm-gutters]:border-border">
            <CodeMirror value={code} onChange={setCode} extensions={extensions} theme={dark ? "dark" : "light"} height="460px" width="100%" maxWidth="100%" basicSetup={{ tabSize: 2, foldGutter: false }} aria-label="Function code" />
          </div>
        ) : (
          <CardBody>
            <p className="text-[13px] text-muted">Viewers can't see function source code.</p>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title={tab === "invoke" ? "Test" : "Logs"} actions={<Tabs tabs={[{ value: "invoke" as const, label: "Invoke" }, { value: "logs" as const, label: "Logs" }]} value={tab} onValueChange={setTab} />} />
        {tab === "invoke" ? (
          <CardBody className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-[110px_minmax(0,1fr)_170px]">
              <Select value={method} onChange={(e) => setMethod(e.target.value)} options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))} aria-label="Method" />
              <Input value={fn.url} readOnly className="font-mono text-[12px]" aria-label="URL" />
              <Select
                value={auth}
                onChange={(e) => setAuth(e.target.value as typeof auth)}
                aria-label="Authorization"
                options={[
                  { value: "anon", label: "anon key" },
                  { value: "service_role", label: "service_role key", disabled: !canUseServiceKey },
                  { value: "none", label: "No Authorization" },
                ]}
              />
            </div>
            {method !== "GET" && <Textarea value={reqBody} onChange={(e) => setReqBody(e.target.value)} rows={4} className="font-mono text-[12px]" aria-label="Request body" />}
            <div className="flex justify-end">
              <Button variant="secondary" leftIcon={<Play className="h-3.5 w-3.5" />} loading={busy === "invoke"} disabled={!canUse || !running} onClick={invoke}>
                Send request
              </Button>
            </div>
            {result && (
              <div className="overflow-hidden rounded-md border border-border">
                <div className="flex items-center gap-3 border-b border-border bg-bg-subtle px-3 py-2 text-[12px]">
                  <Badge tone={result.status < 300 ? "success" : result.status < 500 ? "warning" : "danger"}>{result.status}</Badge>
                  <span className="text-muted">{result.durationMs} ms</span>
                  <span className="truncate text-subtle">{result.headers["content-type"] ?? ""}</span>
                </div>
                <pre className={cn("max-h-80 overflow-auto p-3 font-mono text-[12px]", result.status >= 400 && "text-danger")}>{pretty || "(empty body)"}</pre>
              </div>
            )}
          </CardBody>
        ) : (
          <CardBody>
            <LogViewer src={`${p}/logs`} height={360} emptyText="Waiting for invocations…" />
          </CardBody>
        )}
      </Card>

      <TypedConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title="Delete function"
        description={<>Requests to <span className="font-mono">{fn.url}</span> will return 404.</>}
        expected={fn.slug}
        action="Delete"
        busy={busy === "delete"}
        onConfirm={async () => {
          setBusy("delete");
          try {
            await api(p, { method: "DELETE" });
            toast.success(`Deleted ${fn.slug}`);
            router.push(`${basePath}/functions`);
            router.refresh();
          } catch (e) {
            toast.error("Could not delete", errMsg(e));
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}
