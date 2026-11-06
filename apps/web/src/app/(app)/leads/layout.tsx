import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/leads">) {
  return <SectionShell section="leads">{children}</SectionShell>;
}
