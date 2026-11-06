import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/numbers">) {
  return <SectionShell section="numbers">{children}</SectionShell>;
}
