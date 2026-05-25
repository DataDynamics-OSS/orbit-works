import localFont from "next/font/local";

// Root layout 과 동일한 self-hosted variable 폰트.
const robotoCondensed = localFont({
  src: "../../fonts/RobotoCondensed-Variable.woff2",
  weight: "100 900",
  display: "swap",
});

export default function ApprovalsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${robotoCondensed.className} text-sm flex flex-col min-h-0 flex-1`}
    >
      {children}
    </div>
  );
}
