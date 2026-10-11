"use client";

import { useState, type FormEvent } from "react";

export default function SignInPage() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/sign-in", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    const result = await response.json() as { error?: string };
    if (response.ok) {
      window.location.assign("/plays");
      return;
    }
    setMessage(result.error ?? "Unable to sign in");
    setBusy(false);
  }
  return <main className="auth-page"><section className="auth-card"><p className="eyebrow">Private beta</p>
    <h1>Sign in to rehearse</h1><p>Open your private script library and grounded actor workbooks.</p>
    <form action="/api/auth/sign-in" method="post" onSubmit={signIn}><label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="email" required />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      <button type="submit" data-native-submit="true" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>{message ? <p role="alert">{message}</p> : null}</section></main>;
}
