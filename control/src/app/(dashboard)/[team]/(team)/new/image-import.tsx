"use client";

import { useState } from "react";
import { Container } from "lucide-react";
import { Button, Card, CardBody, CardFooter, CardHeader, Field, Input } from "@/components/ui";
import type { Selection } from "./types";

export function ImageImport({ onSelect }: { onSelect: (s: Selection) => void }) {
  const [image, setImage] = useState("");
  const [port, setPort] = useState("80");
  const valid = /^[a-z0-9][a-z0-9._\-/:@]{0,250}$/i.test(image.trim());
  return (
    <Card>
      <CardHeader title="Deploy a Docker image" description="Run any public image (Docker Hub, GHCR, Quay…) or one from the registry configured in Platform Settings. No build step." />
      <CardBody className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <Field label="Image" htmlFor="img" hint="e.g. nginx:1.27-alpine, ghcr.io/acme/api:latest">
          <Input id="img" prefix={<Container className="h-4 w-4" />} value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:alpine" spellCheck={false} />
        </Field>
        <Field label="Port" htmlFor="img-port" hint="Port the container listens on">
          <Input id="img-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
        </Field>
      </CardBody>
      <CardFooter>
        <Button variant="primary" size="sm" disabled={!valid} onClick={() => onSelect({ kind: "image", image: image.trim(), port: Number(port) || 80 })}>
          Continue
        </Button>
      </CardFooter>
    </Card>
  );
}
