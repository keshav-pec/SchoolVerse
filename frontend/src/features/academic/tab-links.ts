/** Which session tab shows the thing a validation issue is about. */
export const TAB_FOR_ENTITY: Record<string, string> = {
  grade_offering: 'grades',
  academic_term: 'terms',
  subject_choice_group: 'rules',
  subject_choice_constraint: 'rules',
  academic_programme: 'programmes',
  session_location: 'overview',
  academic_session: 'overview',
};

export const TAB_LABELS: Record<string, string> = {
  overview: 'Overview',
  grades: 'Grades & Sections',
  subjects: 'Subjects',
  rules: 'Choice Rules',
  programmes: 'Programmes',
  terms: 'Terms',
};
