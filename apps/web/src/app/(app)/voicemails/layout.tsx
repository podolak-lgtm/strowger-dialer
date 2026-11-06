import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/voicemails">) {
  return <SectionShell section="numbers">{children}</SectionShell>;
}
