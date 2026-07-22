export const formatTmdbScore = (userScore?: number): string | undefined =>
  typeof userScore === 'number' && userScore > 0
    ? `${Math.round(userScore * 10)}%`
    : undefined;
