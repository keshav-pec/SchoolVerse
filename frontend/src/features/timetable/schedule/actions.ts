import type { AlternativeDTO, GridCellDTO, Weekday } from '@shared';
import { calls, withOptions, type Body } from './api';
import { useEditor } from './editor';

/** The lesson's name for messages. */
export const lessonName = (c: Pick<GridCellDTO, 'groupName' | 'subjectName' | 'activityName'>) => c.groupName ?? c.subjectName ?? c.activityName ?? 'Lesson';

/** Every change a person can make to one lesson, each through the editor, so each one autosaves, can be undone and explains a clash. */
export function useLessonActions() {
  const editor = useEditor();
  const { versionId, exec } = editor;

  const applyAlternative = (cell: GridCellDTO) => async (alt: AlternativeDTO) => {
    if (alt.kind === 'SLOT' && alt.weekday && alt.periodId) await move(cell, alt.weekday, alt.periodId);
    else if (alt.kind === 'ROOM') await setRoom(cell, alt.physicalSpaceId);
    else if (alt.kind === 'TEACHER' && alt.employeeId) await setTeacher(cell, alt.employeeId);
  };

  const move = (cell: GridCellDTO, weekday: Weekday, periodId: string) =>
    exec(`Move ${lessonName(cell)}`, (o) => calls.moveEntry(cell.entryId, withOptions({ weekday, periodId, expectedVersion: cell.version }, o)), { apply: applyAlternative(cell) });

  const swap = (a: GridCellDTO, b: GridCellDTO) => exec(`Swap ${lessonName(a)} and ${lessonName(b)}`, (o) => calls.moveEntry(a.entryId, withOptions({ swapWith: b.entryId, expectedVersion: a.version }, o)));

  const setTeacher = (cell: GridCellDTO, employeeId: string) =>
    exec('Change teacher', (o) => calls.updateEntry(cell.entryId, withOptions({ teacherIds: [employeeId], expectedVersion: cell.version }, o)), { apply: applyAlternative(cell) });

  const setRoom = (cell: GridCellDTO, physicalSpaceId: string | null) =>
    exec('Change room', (o) => calls.updateEntry(cell.entryId, withOptions({ physicalSpaceId, expectedVersion: cell.version }, o)), { apply: applyAlternative(cell) });

  const setFixed = (cell: GridCellDTO, isFixed: boolean) => exec(isFixed ? 'Fix this period' : 'Unlock this period', (o) => calls.updateEntry(cell.entryId, withOptions({ isFixed, expectedVersion: cell.version }, o)));

  const setNotes = (cell: GridCellDTO, notes: string) => exec('Save note', (o) => calls.updateEntry(cell.entryId, withOptions({ notes: notes.trim() || null, expectedVersion: cell.version }, o)), { quiet: true });

  const remove = (cell: GridCellDTO) => exec(`Remove ${lessonName(cell)}`, (o) => calls.deleteEntry(cell.entryId, withOptions({ expectedVersion: cell.version }, o)));

  const add = (label: string, body: Body) => exec(label, (o) => calls.createEntry(versionId, withOptions(body, o)));

  return { move, swap, setTeacher, setRoom, setFixed, setNotes, remove, add, applyAlternative };
}
