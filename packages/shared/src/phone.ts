/** Ten NANP digits, the one shape every table stores. Null when it is not a phone. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // NANP: area code and exchange may not start with 0 or 1.
  if (/^[01]/.test(digits) || /^[01]/.test(digits.slice(3, 4))) return null;
  // Obvious junk: all one digit, 555-01xx test range.
  if (/^(\d)\1{9}$/.test(digits)) return null;
  if (digits.slice(3, 6) === "555" && digits.slice(6, 8) === "01") return null;
  return digits;
}

export function toE164(tenDigits: string): string {
  return `+1${tenDigits}`;
}

export function areaCodeOf(tenDigits: string): string {
  return tenDigits.slice(0, 3);
}

export function formatPhone(tenDigits: string | null | undefined): string {
  if (!tenDigits || tenDigits.length !== 10) return tenDigits ?? "";
  return `(${tenDigits.slice(0, 3)}) ${tenDigits.slice(3, 6)}-${tenDigits.slice(6)}`;
}
