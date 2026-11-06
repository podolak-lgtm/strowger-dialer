import { SectionShell } from "@/components/section-shell";

export default function Layout({ children }: LayoutProps<"/skills">) {
  return <SectionShell section="numbers">{children}</SectionShell>;
}
