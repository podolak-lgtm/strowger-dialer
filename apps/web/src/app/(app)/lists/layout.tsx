import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/lists">) {
  return <SectionShell section="leads">{children}</SectionShell>;
}
