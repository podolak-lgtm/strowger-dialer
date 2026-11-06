import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/reports">) {
  return <SectionShell section="dashboard">{children}</SectionShell>;
}
