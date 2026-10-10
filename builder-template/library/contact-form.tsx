"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getSupabase } from "@/lib/supabase";

/**
 * Contact form. Saves to the `contact_messages` table of the attached backend:
 *   create table public.contact_messages (id bigint generated always as identity primary key, name text not null,
 *     email text not null, message text not null, created_at timestamptz not null default now());
 *   alter table public.contact_messages enable row level security;
 *   create policy "anyone can send" on public.contact_messages for insert to anon, authenticated with check (true);
 */
export default function ContactForm() {
  const [sending, setSending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const row = { name: String(data.get("name") ?? ""), email: String(data.get("email") ?? ""), message: String(data.get("message") ?? "") };
    const supabase = getSupabase();
    if (!supabase) {
      toast.error("The backend is not connected yet.");
      return;
    }
    setSending(true);
    const { error } = await supabase.from("contact_messages").insert(row);
    setSending(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    form.reset();
    toast.success("Thanks! We will get back to you soon.");
  }

  return (
    <section className="container max-w-2xl py-20">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Get in touch</CardTitle>
          <CardDescription>Send us a message and we will reply within one business day.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required placeholder="Your name" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required placeholder="you@example.com" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="message">Message</Label>
              <Textarea id="message" name="message" required rows={5} placeholder="How can we help?" />
            </div>
            <Button type="submit" disabled={sending} className="justify-self-start">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send message
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
