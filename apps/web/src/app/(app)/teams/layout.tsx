import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/teams">) {
  return <SectionShell section="people">{children}</SectionShell>;
}
