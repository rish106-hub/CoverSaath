// Tiny DOM helpers shared by every view. Text always goes through text nodes, never innerHTML.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (['checked', 'disabled', 'hidden', 'required', 'open', 'multiple'].includes(key)) node[key] = Boolean(value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const hint = (text, attrs = {}) => el('p', { class: 'hint', ...attrs }, text);

/** Labelled form control. The label is always visible and tied to the control. */
export function field({ label, name, type = 'text', help, testid, value, options, ...attrs }) {
  const id = `f-${name}`;
  const helpId = help ? `${id}-help` : undefined;
  let control;
  if (type === 'select') {
    control = el('select', { id, name, 'aria-describedby': helpId, 'data-testid': testid, ...attrs },
      options.map(([optionValue, text]) => el('option', { value: optionValue, ...(String(optionValue) === String(value ?? '') ? { selected: true } : {}) }, text)));
  } else if (type === 'textarea') {
    control = el('textarea', { id, name, rows: 3, 'aria-describedby': helpId, 'data-testid': testid, ...attrs }, value ?? '');
  } else {
    control = el('input', { id, name, type, 'aria-describedby': helpId, 'data-testid': testid, ...(value !== undefined ? { value } : {}), ...attrs });
  }
  return el('div', { class: 'field' }, el('label', { for: id }, label), control, help ? el('p', { class: 'hint', id: helpId }, help) : null);
}

export const button = (text, { variant = '', testid, ...attrs } = {}) =>
  el('button', { class: `button ${variant}`.trim(), type: 'button', 'data-testid': testid, ...attrs }, text);

/** Reads every named control of a form into a plain object. */
export const formValues = form => Object.fromEntries(new FormData(form).entries());
