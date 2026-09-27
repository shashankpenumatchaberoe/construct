import { useCallback } from 'react';

export function useWidget() {
  return { action: useCallback(() => {}, []) };
}
