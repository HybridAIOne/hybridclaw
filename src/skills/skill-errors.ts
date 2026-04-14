import { AppError } from '../errors/app-error.js';

export class SkillImportError extends AppError {}

export class SkillImportNotFoundError extends SkillImportError {}
