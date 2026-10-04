export function RequiredIndicator() {
  return (
    <>
      <span aria-hidden="true" className="ml-1 text-[var(--danger)]">*</span>
      <span className="sr-only"> (required)</span>
    </>
  );
}
