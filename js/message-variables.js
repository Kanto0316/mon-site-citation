const MESSAGE_VARIABLES = ['{Nom}', '{Prénom}', '{NomComplet}', '{Mail}', '{Role}', '{Point}'];

function cleanMessageVariableValue(value) {
  return String(value || '').trim();
}

function splitMessageVariableFullName(value) {
  return cleanMessageVariableValue(value).replace(/\s+/g, ' ').split(' ').filter(Boolean);
}

function resolveMessageVariableDisplayName(user) {
  const displayName = cleanMessageVariableValue(user?.displayName || user?.username || user?.name);
  if (displayName) {
    return displayName;
  }
  const emailPrefix = cleanMessageVariableValue(user?.email).split('@')[0];
  return emailPrefix || 'Utilisateur';
}

function resolveMessageVariableFirstName(user) {
  const explicitFirstName = cleanMessageVariableValue(user?.firstName || user?.prenom || user?.['prénom']);
  if (explicitFirstName) {
    return explicitFirstName;
  }
  const nameParts = splitMessageVariableFullName(resolveMessageVariableDisplayName(user));
  return nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : nameParts[0] || '';
}

function resolveMessageVariableLastName(user) {
  const explicitLastName = cleanMessageVariableValue(user?.lastName || user?.nom);
  if (explicitLastName) {
    return explicitLastName;
  }
  const nameParts = splitMessageVariableFullName(resolveMessageVariableDisplayName(user));
  return nameParts.length > 1 ? nameParts[nameParts.length - 1] : resolveMessageVariableDisplayName(user);
}

function resolveMessageVariableRole(user) {
  const role = cleanMessageVariableValue(user?.role);
  return role || '';
}

function resolveMessageVariablePoint(user, pointsByUser = {}) {
  if (user?.point !== undefined) {
    return String(Number(user.point || 0));
  }
  if (user?.points !== undefined) {
    return String(Number(user.points || 0));
  }
  if (user?.id && pointsByUser?.[user.id] !== undefined) {
    return String(Number(pointsByUser[user.id] || 0));
  }
  if (user?.uid && pointsByUser?.[user.uid] !== undefined) {
    return String(Number(pointsByUser[user.uid] || 0));
  }
  return '0';
}

export function buildMessageVariables(user, pointsByUser = {}) {
  return {
    '{Nom}': resolveMessageVariableLastName(user),
    '{Prénom}': resolveMessageVariableFirstName(user),
    '{NomComplet}': resolveMessageVariableDisplayName(user),
    '{Mail}': cleanMessageVariableValue(user?.email),
    '{Role}': resolveMessageVariableRole(user),
    '{Point}': resolveMessageVariablePoint(user, pointsByUser),
  };
}

export function replaceVariables(text, user, pointsByUser = {}) {
  const variables = buildMessageVariables(user, pointsByUser);
  return MESSAGE_VARIABLES.reduce(
    (message, variable) => message.split(variable).join(variables[variable] || ''),
    String(text || ''),
  );
}

export { MESSAGE_VARIABLES };
