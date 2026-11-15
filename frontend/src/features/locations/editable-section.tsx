import { useEffect, useState, type ReactNode } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { missingActivationFields, updateLocationSchema, type LocationDetailDTO, type SchoolDTO, type UpdateLocationInput } from '@shared';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Can } from '@/components/sv/can';
import { applyServerErrors } from '@/lib/errors';
import { useUpdateLocation } from './api';
import { ALL_LOCATION_FIELDS, toFormValues, type LocationForm, type LocationFormValues } from './location-form';

interface Props {
  title: string;
  location: LocationDetailDTO;
  /** Fields this section owns. Only changed ones are sent. */
  fields: readonly string[];
  view: ReactNode;
  editor: (form: LocationForm, school?: SchoolDTO) => ReactNode;
  school?: SchoolDTO;
  successMessage: string;
  /** Archived locations are read-only. */
  readOnly?: boolean;
}

/** A card that flips between a read view and an in-place edit form (PATCH of just the changed fields). */
export function EditableSection({ title, location, fields, view, editor, school, successMessage, readOnly }: Props) {
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const update = useUpdateLocation(location.locationId);

  const form = useForm<LocationFormValues>({
    resolver: zodResolver(updateLocationSchema) as unknown as Resolver<LocationFormValues>,
    defaultValues: toFormValues(location),
    mode: 'onTouched',
  });

  useEffect(() => {
    if (!editing) form.reset(toFormValues(location));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, editing]);

  const cancel = () => {
    form.reset(toFormValues(location));
    setFormError(null);
    setEditing(false);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    const dirty = form.formState.dirtyFields as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of fields) {
      if (!dirty[key]) continue;
      patch[key] = key === 'address' ? values.address : (values as unknown as Record<string, unknown>)[key];
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }

    // ACTIVE / INACTIVE locations must stay complete (server enforces the same rule).
    if (location.status !== 'DRAFT') {
      const merged = { phone: values.phone || null, address: values.address };
      const missing = missingActivationFields(merged);
      const mine = Object.entries(missing).filter(([f]) => fields.includes(f.startsWith('address.') ? 'address' : f));
      if (mine.length > 0) {
        for (const [f, message] of mine) form.setError(f as never, { type: 'required', message: message.replace('for an active location', 'for this location') });
        return;
      }
    }

    try {
      await update.mutateAsync(patch as UpdateLocationInput);
      toast.success(successMessage);
      setEditing(false);
    } catch (err) {
      setFormError(applyServerErrors(err, form.setError, ALL_LOCATION_FIELDS));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {!editing && !readOnly && (
          <Can permission="location:edit">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${title}`}>
              <Pencil /> Edit
            </Button>
          </Can>
        )}
      </CardHeader>
      {editing ? (
        <form onSubmit={onSubmit} noValidate className="space-y-5">
          {formError && <Alert tone="danger">{formError}</Alert>}
          {editor(form, school)}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={cancel} disabled={update.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={update.isPending} loadingText="Saving…">
              Save changes
            </Button>
          </div>
        </form>
      ) : (
        view
      )}
    </Card>
  );
}
