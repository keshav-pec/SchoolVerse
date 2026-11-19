import { useState } from 'react';
import {
  CHANGE_FIELD_LABELS,
  createChangeRequestSchema,
  GOVERNMENT_ID_LABELS,
  GOVERNMENT_ID_TYPES,
  type ChangeFieldCategory,
  type GovernmentIdType,
  type ProfileChangeRequestDTO,
  type SelfProfileDTO,
} from '@shared';
import { Send } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { ComboboxField, TextField } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { useStepUp } from '@/lib/step-up';
import { usePeopleMutation } from '../people/api';

const SENSITIVE: ChangeFieldCategory[] = ['GOVERNMENT_ID', 'BANK_DETAILS'];

const INTRO: Record<ChangeFieldCategory, string> = {
  LEGAL_NAME:
    'Your legal name changes only after a School Admin approves it. Until then the current name stays.',
  DATE_OF_BIRTH: 'Your date of birth changes only after a School Admin approves it.',
  GOVERNMENT_ID:
    'The ID is stored encrypted and shown to the approver masked. We ask for your password first.',
  BANK_DETAILS:
    'Bank details are stored encrypted and shown to the approver masked. We ask for your password first.',
};

/** Asks for a change to a detail an employee cannot edit directly. It goes to an approver; nothing changes until they say yes. */
export function RequestChangeDialog({
  category,
  profile,
  onClose,
}: {
  category: ChangeFieldCategory;
  profile: SelfProfileDTO;
  onClose: () => void;
}) {
  const { withStepUp } = useStepUp();
  const p = profile.profile;
  const [values, setValues] = useState<Record<string, string>>({
    legalFirstName: p.legalFirstName,
    legalMiddleName: p.legalMiddleName ?? '',
    legalLastName: p.legalLastName,
    dateOfBirth: '',
    type: 'PAN',
    value: '',
    accountHolderName: `${p.legalFirstName} ${p.legalLastName}`,
    accountNumber: '',
    ifsc: '',
    bankName: '',
    reason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const create = usePeopleMutation(
    (body: object) => {
      const send = () => api.post<ProfileChangeRequestDTO>('/me/profile-change-requests', body);
      return SENSITIVE.includes(category) ? withStepUp(send) : send();
    },
    { quiet: true, success: 'Request sent. A School Admin will review it.' },
  );

  const valueFor = () => {
    switch (category) {
      case 'LEGAL_NAME':
        return {
          legalFirstName: values.legalFirstName,
          legalMiddleName: values.legalMiddleName,
          legalLastName: values.legalLastName,
        };
      case 'DATE_OF_BIRTH':
        return { dateOfBirth: values.dateOfBirth };
      case 'GOVERNMENT_ID':
        return { type: values.type, value: values.value };
      case 'BANK_DETAILS':
        return {
          accountHolderName: values.accountHolderName,
          accountNumber: values.accountNumber,
          ifsc: values.ifsc,
          bankName: values.bankName,
        };
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<Send className="size-5" />}
      title={`Request a change to your ${CHANGE_FIELD_LABELS[category].toLowerCase()}`}
      description={INTRO[category]}
      confirmLabel="Send request"
      loadingLabel="Sending…"
      onConfirm={async () => {
        setErrors({});
        const body = {
          fieldCategory: category,
          value: valueFor(),
          reason: (values.reason ?? '').trim() || undefined,
        };
        const parsed = createChangeRequestSchema.safeParse(body);
        if (!parsed.success) {
          const next: Record<string, string> = {};
          for (const issue of parsed.error.issues)
            next[String(issue.path[issue.path.length - 1] ?? '_form')] ??= issue.message;
          setErrors(next);
          throw new FormProblem('Check the highlighted details.');
        }
        await create.mutateAsync(body);
      }}
    >
      <div className="space-y-4">
        {category === 'LEGAL_NAME' && (
          <>
            <TextField
              label="First name"
              required
              value={values.legalFirstName}
              onChange={set('legalFirstName')}
              error={errors.legalFirstName}
            />
            <TextField
              label="Middle name"
              value={values.legalMiddleName}
              onChange={set('legalMiddleName')}
              error={errors.legalMiddleName}
            />
            <TextField
              label="Last name"
              required
              value={values.legalLastName}
              onChange={set('legalLastName')}
              error={errors.legalLastName}
            />
          </>
        )}
        {category === 'DATE_OF_BIRTH' && (
          <TextField
            label="Correct date of birth"
            type="date"
            required
            value={values.dateOfBirth}
            onChange={set('dateOfBirth')}
            error={errors.dateOfBirth}
          />
        )}
        {category === 'GOVERNMENT_ID' && (
          <>
            <ComboboxField
              label="ID type"
              value={values.type ?? ''}
              onChange={(type) => setValues((v) => ({ ...v, type }))}
              options={GOVERNMENT_ID_TYPES.map((t: GovernmentIdType) => ({ value: t, label: GOVERNMENT_ID_LABELS[t] }))}
              searchPlaceholder="Search ID types…"
            />
            <TextField
              label="ID number"
              required
              autoComplete="off"
              value={values.value}
              onChange={set('value')}
              error={errors.value}
            />
          </>
        )}
        {category === 'BANK_DETAILS' && (
          <>
            <TextField
              label="Account holder name"
              required
              value={values.accountHolderName}
              onChange={set('accountHolderName')}
              error={errors.accountHolderName}
            />
            <TextField
              label="Account number"
              required
              inputMode="numeric"
              autoComplete="off"
              value={values.accountNumber}
              onChange={set('accountNumber')}
              error={errors.accountNumber}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="IFSC code"
                required
                autoComplete="off"
                value={values.ifsc}
                onChange={set('ifsc')}
                error={errors.ifsc}
              />
              <TextField
                label="Bank name"
                required
                value={values.bankName}
                onChange={set('bankName')}
                error={errors.bankName}
              />
            </div>
          </>
        )}
        <TextField
          label="Why?"
          hint="Optional. Helps the approver."
          value={values.reason}
          onChange={set('reason')}
          maxLength={300}
        />
        {SENSITIVE.includes(category) && (
          <Alert tone="info">You will be asked for your password when you send this.</Alert>
        )}
      </div>
    </ConfirmDialog>
  );
}
