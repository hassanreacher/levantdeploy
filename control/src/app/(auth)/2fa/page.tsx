import { TwoFactorForm } from "./two-factor-form";

export const metadata = { title: "Two-factor authentication" };

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <TwoFactorForm next={next} />;
}
