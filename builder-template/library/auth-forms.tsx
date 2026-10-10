"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getSupabase } from "@/lib/supabase";

/** Sign in / sign up with email + password (LevantBase / Supabase Auth). */
export default function AuthForms() {
  const [busy, setBusy] = useState(false);

  async function submit(kind: "signin" | "signup", e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const supabase = getSupabase();
    if (!supabase) {
      toast.error("The backend is not connected yet.");
      return;
    }
    setBusy(true);
    const { error } = kind === "signin" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) toast.error(error.message);
    else toast.success(kind === "signin" ? "Welcome back!" : "Check your inbox to confirm your email.");
  }

  return (
    <section className="container flex justify-center py-20">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome</CardTitle>
          <CardDescription>Sign in to your account or create a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>
            {(["signin", "signup"] as const).map((kind) => (
              <TabsContent key={kind} value={kind}>
                <form onSubmit={(e) => submit(kind, e)} className="grid gap-4 pt-4">
                  <div className="grid gap-2">
                    <Label htmlFor={`${kind}-email`}>Email</Label>
                    <Input id={`${kind}-email`} name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`${kind}-password`}>Password</Label>
                    <Input
                      id={`${kind}-password`}
                      name="password"
                      type="password"
                      required
                      minLength={6}
                      autoComplete={kind === "signin" ? "current-password" : "new-password"}
                    />
                  </div>
                  <Button type="submit" disabled={busy} className="w-full">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {kind === "signin" ? "Sign in" : "Create account"}
                  </Button>
                </form>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </section>
  );
}
