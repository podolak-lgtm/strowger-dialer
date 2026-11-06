import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/inbound">) {
  return <SectionShell section="numbers">{children}</SectionShell>;
}
