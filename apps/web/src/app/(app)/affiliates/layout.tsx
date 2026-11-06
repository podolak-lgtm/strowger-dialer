import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/affiliates">) {
  return <SectionShell section="leads">{children}</SectionShell>;
}
