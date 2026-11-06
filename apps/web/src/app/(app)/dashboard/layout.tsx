import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/dashboard">) {
  return <SectionShell section="dashboard">{children}</SectionShell>;
}
