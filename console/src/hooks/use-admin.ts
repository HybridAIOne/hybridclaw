import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth';

export function useAdminToken(): string {
  return useAuth().token;
}

export function useAdminQueryClient() {
  return useQueryClient();
}
