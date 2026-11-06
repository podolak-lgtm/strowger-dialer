import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/cadences">) {
  return <SectionShell section="leads">{children}</SectionShell>;
}
