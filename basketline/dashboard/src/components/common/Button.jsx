export function Button({ variant = 'primary', size, className = '', type = 'button', ...props }) {
  const classes = ['btn', `btn--${variant}`, size ? `btn--${size}` : '', className].filter(Boolean).join(' ')
  return <button type={type} className={classes} {...props} />
}
