import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { missingActivationFields, updateLocationSchema, type LocationDetailDTO, type SchoolDTO, type UpdateLocationInput } from '@shared';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { useLocation, useUpdateLocation } from './api';
import { ALL_LOCATION_FIELDS, buildLocationPatch, LocationEditorFields, LOCATION_PATCH_FIELDS, toFormValues, type LocationFormValues } from './location-form';

function EditForm({ detail, school, onClose }: { detail: LocationDetailDTO; school: SchoolDTO; onClose: () => void }) {
  const { can } = useAuth();
  const update = useUpdateLocation(detail.locationId);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<LocationFormValues>({
    resolver: zodResolver(updateLocationSchema) as unknown as Resolver<LocationFormValues>,
    defaultValues: toFormValues(detail),
    mode: 'onTouched',
  });

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    const patch = buildLocationPatch(LOCATION_PATCH_FIELDS, form.formState.dirtyFields as Record<string, unknown>, values as unknown as Record<string, unknown>);
    if (Object.keys(patch).length === 0) return onClose();

    // Non-draft locations must stay complete; say so on the field instead of waiting for the server.
    if (detail.status !== 'DRAFT') {
      const missing = missingActivationFields({ phone: values.phone || null, address: values.address });
      const entries = Object.entries(missing);
      if (entries.length > 0) {
        for (const [field, message] of entries) form.setError(field as never, { type: 'required', message: message.replace('for an active location', 'for this location') });
        return;
      }
    }
    try {
      await update.mutateAsync(patch as UpdateLocationInput);
      toast.success('Location details updated.');
      onClose();
    } catch (err) {
      setFormError(applyServerErrors(err, form.setError, ALL_LOCATION_FIELDS));
    }
  });

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DrawerBody>
        {formError && (
          <Alert tone="danger" className="mb-5">
            {formError}
          </Alert>
        )}
        <LocationEditorFields form={form} school={school} location={detail} canCheckCode={can('location:view_config')} showNotes />
      </DrawerBody>
      <DrawerFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={update.isPending} loadingText="Saving…">
          Save changes
        </Button>
      </DrawerFooter>
    </form>
  );
}

/** Edit a whole location in a side panel (used by the setup wizard's "Additional Locations" list). */
export function EditLocationDrawer({ locationId, school, open, onOpenChange }: { locationId: string | null; school: SchoolDTO; open: boolean; onOpenChange: (open: boolean) => void }) {
  const detail = useLocation(open ? (locationId ?? undefined) : undefined);
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Edit location" description="Change any detail. Only what you change is saved." onInteractOutside={(e) => e.preventDefault()}>
        {detail.isLoading && (
          <div className="space-y-4 p-6" role="status" aria-label="Loading location">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-40" />
          </div>
        )}
        {detail.isError && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
        {detail.data && <EditForm key={detail.data.locationId} detail={detail.data} school={school} onClose={() => onOpenChange(false)} />}
      </DrawerContent>
    </Drawer>
  );
}
