export const Logo = ({ size = 24 }) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="100" cy="100" r="100" fill={"var(--color-foreground)"} />
      {/* almond eyepatch, slightly tilted */}
      <ellipse
        cx="100"
        cy="88"
        rx="32"
        ry="14"
        fill={"var(--color-muted)"}
        transform="rotate(-18 100 88)"
      />
    </svg>
  );
};
