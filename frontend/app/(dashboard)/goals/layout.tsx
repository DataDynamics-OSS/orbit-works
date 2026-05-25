import localFont from "next/font/local";

const robotoCondensed = localFont({
  src: "../../fonts/RobotoCondensed-Variable.woff2",
  weight: "100 900",
  display: "swap",
});

export default function GoalsLayout({
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
