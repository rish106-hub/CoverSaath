// Members, policies and the Home overview for the app (app-data plan B-A). Authorisation lives here: every method checks
// household ownership first, and writes need the owner or member role (a viewer reads only). Derived numbers are counts and
// day differences computed in this file; no model output and no stored aggregate is involved.
const MEMBER_KINDS = ['adult', 'dependent'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WRITE_ROLES = ['owner', 'member'];

function fail(code, message, statusCode) {
  throw Object.assign(new Error(message), { code, statusCode });
}

function invalid(message) { fail('INVALID_REQUEST', message, 400); }

function text(value, field, { max, required = false }) {
  if (value === undefined || value === null) {
    if (required) invalid(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') invalid(`${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) { if (required) invalid(`${field} is required.`); return null; }
  if (trimmed.length > max || /[\u0000-\u001f]/.test(trimmed)) invalid(`${field} is invalid.`);
  return trimmed;
}

function dateOfBirth(value, now) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ISO_DAY.test(value)) invalid('dateOfBirth must be a date as YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid('dateOfBirth must be a real date.');
  if (value < '1900-01-01' || parsed.getTime() > now.getTime()) invalid('dateOfBirth is out of range.');
  return value;
}

const dayNumber = iso => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

export function ageYears(born, now) {
  if (!born || !ISO_DAY.test(born)) return null;
  const today = now.toISOString().slice(0, 10);
  let years = Number(today.slice(0, 4)) - Number(born.slice(0, 4));
  if (today.slice(5) < born.slice(5)) years -= 1;
  return years < 0 ? null : years;
}

export function createHouseholdAppService({ access, appRepository, consents, households, clock = () => new Date() }) {
  const requireWrite = async (principal, householdId) => {
    const { role } = await access.requireHousehold(principal, householdId);
    if (!WRITE_ROLES.includes(role.role)) fail('HOUSEHOLD_WRITE_FORBIDDEN', 'Your role in this household can read but not change it.', 403);
    return role;
  };

  // A date of birth is shown to the viewer when it belongs to a dependent, to themselves, or when the subject adult granted
  // field access (same rule as the household matrix). A placeholder adult cannot grant, so theirs stays withheld.
  async function visibleBirth(principal, householdId, member) {
    if (!member.date_of_birth) return null;
    if (!member.adult_user_id || member.adult_user_id === principal.adultId) return member.date_of_birth;
    const allowed = await consents.canAccessField({ householdId, subjectAdultId: member.adult_user_id, viewerAdultId: principal.adultId, fieldKey: 'date_of_birth' });
    return allowed === true ? member.date_of_birth : null;
  }

  async function memberDto(principal, householdId, member, ownerIds) {
    const born = await visibleBirth(principal, householdId, member);
    return {
      id: member.id,
      displayName: member.display_name,
      memberKind: member.member_kind,
      relationshipLabel: member.relationship_label,
      dateOfBirth: born,
      ageYears: ageYears(born, clock()),
      isOwner: ownerIds.includes(member.id),
      isYou: member.adult_user_id === principal.adultId,
      createdAt: member.created_at,
      updatedAt: member.updated_at,
    };
  }

  function policyDto(policy) {
    const now = clock().toISOString().slice(0, 10);
    const daysUntilEnd = policy.ends_on && ISO_DAY.test(policy.ends_on) ? dayNumber(policy.ends_on) - dayNumber(now) : null;
    return {
      id: policy.id,
      householdId: policy.household_id,
      insurer: policy.insurer_id ? { id: policy.insurer_id, name: policy.insurer_name } : null,
      policyKind: policy.policy_kind,
      policyNumberMasked: policy.policy_number_masked,
      startsOn: policy.starts_on,
      endsOn: policy.ends_on,
      daysUntilEnd,
      verificationState: policy.verification_state,
      members: policy.members,
    };
  }

  return {
    async listMembers(principal, householdId) {
      await access.requireHousehold(principal, householdId);
      const ownerIds = await appRepository.ownerMemberIds(householdId);
      const members = [];
      for (const member of await appRepository.listMembers(householdId)) members.push(await memberDto(principal, householdId, member, ownerIds));
      return { householdId, members };
    },

    async addMember(principal, householdId, body) {
      await requireWrite(principal, householdId);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid('A JSON object is required.');
      if (!MEMBER_KINDS.includes(body.memberKind)) invalid('memberKind must be adult or dependent.');
      const member = await appRepository.createMember({
        householdId,
        actorAdultId: principal.adultId,
        displayName: text(body.displayName, 'displayName', { max: 80, required: true }),
        memberKind: body.memberKind,
        relationshipLabel: text(body.relationshipLabel, 'relationshipLabel', { max: 40 }),
        dateOfBirth: dateOfBirth(body.dateOfBirth, clock()),
      });
      return memberDto(principal, householdId, member, await appRepository.ownerMemberIds(householdId));
    },

    async updateMember(principal, householdId, memberId, body) {
      await requireWrite(principal, householdId);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid('A JSON object is required.');
      if ('memberKind' in body) invalid('memberKind cannot be changed.');
      const changes = {};
      if ('displayName' in body) changes.displayName = text(body.displayName, 'displayName', { max: 80, required: true });
      if ('relationshipLabel' in body) changes.relationshipLabel = text(body.relationshipLabel, 'relationshipLabel', { max: 40 });
      if ('dateOfBirth' in body) changes.dateOfBirth = dateOfBirth(body.dateOfBirth, clock());
      if (Object.keys(changes).length === 0) invalid('Send displayName, relationshipLabel or dateOfBirth.');
      const member = await appRepository.updateMember({ householdId, actorAdultId: principal.adultId, memberId, changes });
      return memberDto(principal, householdId, member, await appRepository.ownerMemberIds(householdId));
    },

    async removeMember(principal, householdId, memberId) {
      await requireWrite(principal, householdId);
      if ((await appRepository.ownerMemberIds(householdId)).includes(memberId)) fail('MEMBER_PROTECTED', 'The household owner cannot be removed.', 409);
      await appRepository.deleteMember({ householdId, actorAdultId: principal.adultId, memberId });
    },

    async listPolicies(principal, householdId) {
      await access.requireHousehold(principal, householdId);
      return { householdId, policies: (await appRepository.listPolicies(householdId)).map(policyDto) };
    },

    async getPolicy(principal, policyId) {
      const policy = await appRepository.getPolicy(policyId);
      // A missing and a foreign policy are indistinguishable.
      if (!policy) fail('POLICY_NOT_FOUND', 'Policy not found.', 404);
      try {
        await access.requireHousehold(principal, policy.household_id);
      } catch (error) {
        if (error.code === 'HOUSEHOLD_NOT_FOUND') fail('POLICY_NOT_FOUND', 'Policy not found.', 404);
        throw error;
      }
      return policyDto(policy);
    },

    async overview(principal, householdId) {
      const { household, role } = await access.requireHousehold(principal, householdId);
      const ownerIds = await appRepository.ownerMemberIds(householdId);
      const members = [];
      for (const member of await appRepository.listMembers(householdId)) members.push(await memberDto(principal, householdId, member, ownerIds));
      const policies = (await appRepository.listPolicies(householdId)).map(policyDto);
      const coveredIds = new Set(policies.flatMap(policy => policy.members.map(member => member.memberId)));
      const dated = policies.filter(policy => policy.daysUntilEnd !== null && policy.daysUntilEnd >= 0).sort((a, b) => a.daysUntilEnd - b.daysUntilEnd);
      const policiesByKind = {};
      for (const policy of policies) policiesByKind[policy.policyKind] = (policiesByKind[policy.policyKind] ?? 0) + 1;
      return {
        household: { id: household.id, displayName: household.display_name, status: household.status },
        viewerRole: role.role,
        members,
        policies,
        counts: {
          members: members.length,
          adults: members.filter(member => member.memberKind === 'adult').length,
          dependents: members.filter(member => member.memberKind === 'dependent').length,
          policies: policies.length,
          policiesByKind,
          membersCovered: members.filter(member => coveredIds.has(member.id)).length,
          membersWithoutPolicy: members.filter(member => !coveredIds.has(member.id)).length,
        },
        nextPolicyEnd: dated[0] ? { policyId: dated[0].id, endsOn: dated[0].endsOn, daysUntilEnd: dated[0].daysUntilEnd } : null,
        derived: 'counts_and_dates_only',
      };
    },
  };
}
