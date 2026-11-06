import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/dids">) {
  return <SectionShell section="numbers">{children}</SectionShell>;
}
