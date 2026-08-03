import MdbListAPI from '@server/api/mdblist';
import PlexTvAPI from '@server/api/plextv';
import type { SortOptions } from '@server/api/themoviedb';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbKeyword,
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type {
  GenreSliderItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapProductionCompany } from '@server/models/Movie';
import {
  mapCollectionResult,
  mapMovieDetailsToResult,
  mapMovieResult,
  mapPersonResult,
  mapTvDetailsToResult,
  mapTvResult,
} from '@server/models/Search';
import { mapNetwork } from '@server/models/Tv';
import { isCollection, isMovie, isPerson } from '@server/utils/typeHelpers';
import { Router } from 'express';
import { sortBy } from 'lodash';
import { z } from 'zod';

export const createTmdbWithRegionLanguage = (user?: User): TheMovieDb => {
  const settings = getSettings();

  const discoverRegion =
    user?.settings?.streamingRegion === 'all'
      ? ''
      : user?.settings?.streamingRegion
        ? user?.settings?.streamingRegion
        : settings.main.discoverRegion;

  const originalLanguage =
    user?.settings?.originalLanguage === 'all'
      ? ''
      : user?.settings?.originalLanguage
        ? user?.settings?.originalLanguage
        : settings.main.originalLanguage;

  return new TheMovieDb({
    discoverRegion,
    originalLanguage,
  });
};

export const createTmdbWithBlocklistSettings = (): TheMovieDb => {
  const settings = getSettings();

  return new TheMovieDb({
    discoverRegion: settings.main.blocklistRegion,
    originalLanguage: settings.main.blocklistLanguage,
  });
};

const discoverRoutes = Router();

const QueryFilterOptions = z.object({
  page: z.coerce.string().optional(),
  sortBy: z.coerce.string().optional(),
  primaryReleaseDateGte: z.coerce.string().optional(),
  primaryReleaseDateLte: z.coerce.string().optional(),
  firstAirDateGte: z.coerce.string().optional(),
  firstAirDateLte: z.coerce.string().optional(),
  studio: z.coerce.string().optional(),
  genre: z.coerce.string().optional(),
  keywords: z.coerce.string().optional(),
  excludeKeywords: z.coerce.string().optional(),
  language: z.coerce.string().optional(),
  withRuntimeGte: z.coerce.string().optional(),
  withRuntimeLte: z.coerce.string().optional(),
  voteAverageGte: z.coerce.string().optional(),
  voteAverageLte: z.coerce.string().optional(),
  voteCountGte: z.coerce.string().optional(),
  voteCountLte: z.coerce.string().optional(),
  network: z.coerce.string().optional(),
  watchProviders: z.coerce.string().optional(),
  watchRegion: z.coerce.string().optional(),
  status: z.coerce.string().optional(),
  certification: z.coerce.string().optional(),
  certificationGte: z.coerce.string().optional(),
  certificationLte: z.coerce.string().optional(),
  certificationCountry: z.coerce.string().optional(),
  certificationMode: z.enum(['exact', 'range']).optional(),
});

export type FilterOptions = z.infer<typeof QueryFilterOptions>;
const ApiQuerySchema = QueryFilterOptions.omit({
  certificationMode: true,
});

const MdbListQuerySchema = ApiQuerySchema.extend({
  url: z.string().min(1),
});

type MdbListResolvedItem =
  | {
      type: MediaType.MOVIE;
      rank: number;
      runtime?: number;
      keywordIds: number[];
      companyIds: number[];
      networkIds: number[];
      result: ReturnType<typeof mapMovieDetailsToResult>;
    }
  | {
      type: MediaType.TV;
      rank: number;
      runtime?: number;
      keywordIds: number[];
      companyIds: number[];
      networkIds: number[];
      result: ReturnType<typeof mapTvDetailsToResult>;
    };

const hasActiveMdbListFilters = (query: FilterOptions): boolean =>
  !!(
    query.sortBy ||
    query.primaryReleaseDateGte ||
    query.primaryReleaseDateLte ||
    query.firstAirDateGte ||
    query.firstAirDateLte ||
    query.genre ||
    query.keywords ||
    query.excludeKeywords ||
    query.language ||
    query.withRuntimeGte ||
    query.withRuntimeLte ||
    query.voteAverageGte ||
    query.voteAverageLte ||
    query.voteCountGte ||
    query.voteCountLte ||
    query.studio ||
    query.network
  );

const splitNumberFilter = (value?: string): number[] =>
  value
    ?.split(/[|,]/)
    .map((filterValue) => Number(filterValue))
    .filter((filterValue) => Number.isFinite(filterValue)) ?? [];

const dateMatches = ({
  value,
  gte,
  lte,
}: {
  value?: string;
  gte?: string;
  lte?: string;
}) => {
  if (!value) {
    return !(gte || lte);
  }

  if (gte && value < gte) {
    return false;
  }

  if (lte && value > lte) {
    return false;
  }

  return true;
};

const filterMdbListItems = (
  items: MdbListResolvedItem[],
  query: FilterOptions
) => {
  const genres = splitNumberFilter(query.genre);
  const keywords = splitNumberFilter(query.keywords);
  const excludeKeywords = splitNumberFilter(query.excludeKeywords);
  const studios = splitNumberFilter(query.studio);
  const networks = splitNumberFilter(query.network);

  return items.filter((item) => {
    if (
      !dateMatches({
        value:
          item.type === MediaType.MOVIE
            ? item.result.release_date
            : item.result.first_air_date,
        gte: query.primaryReleaseDateGte ?? query.firstAirDateGte,
        lte: query.primaryReleaseDateLte ?? query.firstAirDateLte,
      })
    ) {
      return false;
    }

    if (query.language && item.result.original_language !== query.language) {
      return false;
    }

    if (
      genres.length &&
      !genres.some((genreId) => item.result.genre_ids.includes(genreId))
    ) {
      return false;
    }

    if (
      keywords.length &&
      !keywords.some((keywordId) => item.keywordIds.includes(keywordId))
    ) {
      return false;
    }

    if (
      excludeKeywords.length &&
      excludeKeywords.some((keywordId) => item.keywordIds.includes(keywordId))
    ) {
      return false;
    }

    if (
      studios.length &&
      !studios.some((studioId) => item.companyIds.includes(studioId))
    ) {
      return false;
    }

    if (
      networks.length &&
      !networks.some((networkId) => item.networkIds.includes(networkId))
    ) {
      return false;
    }

    if (
      query.withRuntimeGte &&
      (!item.runtime || item.runtime < Number(query.withRuntimeGte))
    ) {
      return false;
    }

    if (
      query.withRuntimeLte &&
      (!item.runtime || item.runtime > Number(query.withRuntimeLte))
    ) {
      return false;
    }

    if (
      query.voteAverageGte &&
      item.result.vote_average < Number(query.voteAverageGte)
    ) {
      return false;
    }

    if (
      query.voteAverageLte &&
      item.result.vote_average > Number(query.voteAverageLte)
    ) {
      return false;
    }

    if (
      query.voteCountGte &&
      item.result.vote_count < Number(query.voteCountGte)
    ) {
      return false;
    }

    if (
      query.voteCountLte &&
      item.result.vote_count > Number(query.voteCountLte)
    ) {
      return false;
    }

    return true;
  });
};

const sortMdbListItems = (
  items: MdbListResolvedItem[],
  sortBy?: SortOptions
) => {
  const sortedItems = [...items];
  const direction = sortBy?.endsWith('.asc') ? 1 : -1;

  switch (sortBy) {
    case 'popularity.asc':
    case 'popularity.desc':
      return sortedItems.sort(
        (a, b) => direction * (a.result.popularity - b.result.popularity)
      );
    case 'release_date.asc':
    case 'release_date.desc':
    case 'first_air_date.asc':
    case 'first_air_date.desc':
      return sortedItems.sort((a, b) => {
        const aDate =
          a.type === MediaType.MOVIE
            ? a.result.release_date
            : a.result.first_air_date;
        const bDate =
          b.type === MediaType.MOVIE
            ? b.result.release_date
            : b.result.first_air_date;

        return direction * aDate.localeCompare(bDate);
      });
    case 'original_title.asc':
    case 'original_title.desc':
      return sortedItems.sort((a, b) => {
        const aTitle =
          a.type === MediaType.MOVIE
            ? a.result.original_title
            : a.result.original_name;
        const bTitle =
          b.type === MediaType.MOVIE
            ? b.result.original_title
            : b.result.original_name;

        return direction * aTitle.localeCompare(bTitle);
      });
    case 'vote_average.asc':
    case 'vote_average.desc':
      return sortedItems.sort(
        (a, b) => direction * (a.result.vote_average - b.result.vote_average)
      );
    case 'vote_count.asc':
    case 'vote_count.desc':
      return sortedItems.sort(
        (a, b) => direction * (a.result.vote_count - b.result.vote_count)
      );
    default:
      return sortedItems.sort((a, b) => a.rank - b.rank);
  }
};

discoverRoutes.get('/mdblist', async (req, res, next) => {
  const settings = getSettings();
  const apiKey = settings.main.mdblistApiKey;

  if (!apiKey) {
    return next({
      status: 400,
      message: 'MDBList API key has not been configured.',
    });
  }

  const itemsPerPage = 20;

  try {
    const query = MdbListQuerySchema.parse(req.query);
    const mdblist = new MdbListAPI(apiKey);
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const page = Number(query.page ?? 1);
    const isFiltered = hasActiveMdbListFilters(query);
    const firstPage = await mdblist.getListItems({
      listUrl: query.url,
      limit: isFiltered ? 100 : itemsPerPage,
      offset: isFiltered ? 0 : (page - 1) * itemsPerPage,
    });

    const listData = isFiltered
      ? [
          firstPage,
          ...(await Promise.all(
            Array.from(
              {
                length: Math.max(
                  0,
                  Math.ceil(firstPage.pagination.total / 100) - 1
                ),
              },
              async (_value, index) =>
                mdblist.getListItems({
                  listUrl: query.url,
                  limit: 100,
                  offset: (index + 1) * 100,
                })
            )
          )),
        ]
      : [firstPage];

    const listItems = listData
      .flatMap((data) => [...data.movies, ...data.shows])
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

    const resolvedItems = (
      await Promise.all(
        listItems.map(
          async (item): Promise<MdbListResolvedItem | undefined> => {
            const tmdbId = item.ids?.tmdb ?? item.id;
            const imdbId = item.ids?.imdb ?? item.imdb_id;
            const tvdbId = item.ids?.tvdb ?? item.tvdb_id;

            try {
              if (item.mediatype === 'movie') {
                if (tmdbId) {
                  const movie = await tmdb.getMovie({ movieId: tmdbId });
                  return {
                    type: MediaType.MOVIE,
                    rank: item.rank ?? 0,
                    runtime: movie.runtime,
                    keywordIds: movie.keywords.keywords.map(
                      (keyword) => keyword.id
                    ),
                    companyIds: movie.production_companies.map(
                      (company) => company.id
                    ),
                    networkIds: [],
                    result: mapMovieDetailsToResult(movie),
                  };
                }

                if (imdbId) {
                  const movie = (await tmdb.getMediaByImdbId({
                    imdbId,
                  })) as TmdbMovieDetails;
                  return {
                    type: MediaType.MOVIE,
                    rank: item.rank ?? 0,
                    runtime: movie.runtime,
                    keywordIds: movie.keywords.keywords.map(
                      (keyword) => keyword.id
                    ),
                    companyIds: movie.production_companies.map(
                      (company) => company.id
                    ),
                    networkIds: [],
                    result: mapMovieDetailsToResult(movie),
                  };
                }
              }

              if (item.mediatype === 'show') {
                if (tmdbId) {
                  const show = await tmdb.getTvShow({ tvId: tmdbId });
                  return {
                    type: MediaType.TV,
                    rank: item.rank ?? 0,
                    runtime: Math.max(...show.episode_run_time, 0) || undefined,
                    keywordIds: show.keywords.results.map(
                      (keyword) => keyword.id
                    ),
                    companyIds: show.production_companies.map(
                      (company) => company.id
                    ),
                    networkIds: show.networks.map((network) => network.id),
                    result: mapTvDetailsToResult(show),
                  };
                }

                if (tvdbId) {
                  const show = await tmdb.getShowByTvdbId({ tvdbId });
                  return {
                    type: MediaType.TV,
                    rank: item.rank ?? 0,
                    runtime: Math.max(...show.episode_run_time, 0) || undefined,
                    keywordIds: show.keywords.results.map(
                      (keyword) => keyword.id
                    ),
                    companyIds: show.production_companies.map(
                      (company) => company.id
                    ),
                    networkIds: show.networks.map((network) => network.id),
                    result: mapTvDetailsToResult(show),
                  };
                }

                if (imdbId) {
                  const show = (await tmdb.getMediaByImdbId({
                    imdbId,
                  })) as TmdbTvDetails;
                  return {
                    type: MediaType.TV,
                    rank: item.rank ?? 0,
                    runtime: Math.max(...show.episode_run_time, 0) || undefined,
                    keywordIds: show.keywords.results.map(
                      (keyword) => keyword.id
                    ),
                    companyIds: show.production_companies.map(
                      (company) => company.id
                    ),
                    networkIds: show.networks.map((network) => network.id),
                    result: mapTvDetailsToResult(show),
                  };
                }
              }
            } catch (e) {
              logger.debug('Unable to resolve MDBList item with TMDB', {
                label: 'API',
                errorMessage: e.message,
                item,
              });
            }
          }
        )
      )
    ).filter((item): item is MdbListResolvedItem => !!item);
    const filteredItems = sortMdbListItems(
      filterMdbListItems(resolvedItems, query),
      query.sortBy as SortOptions
    );
    const pageItems = isFiltered
      ? filteredItems.slice((page - 1) * itemsPerPage, page * itemsPerPage)
      : filteredItems;

    const media = await Media.getRelatedMedia(
      req.user,
      pageItems.map((item) => ({
        tmdbId: item.result.id,
        mediaType: item.type,
      }))
    );

    return res.status(200).json({
      page,
      totalPages: Math.max(
        1,
        Math.ceil(
          (isFiltered ? filteredItems.length : firstPage.pagination.total) /
            itemsPerPage
        )
      ),
      totalResults: isFiltered
        ? filteredItems.length
        : firstPage.pagination.total,
      results: pageItems.map((item) => {
        const relatedMedia = media.find(
          (med) => med.tmdbId === item.result.id && med.mediaType === item.type
        );

        return item.type === MediaType.MOVIE
          ? mapMovieResult(item.result, relatedMedia)
          : mapTvResult(item.result, relatedMedia);
      }),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving MDBList items', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: e.message === 'Invalid MDBList URL.' ? 400 : 500,
      message:
        e.message === 'Invalid MDBList URL.'
          ? 'Invalid MDBList URL.'
          : 'Unable to retrieve MDBList items.',
    });
  }
});

discoverRoutes.get('/movies', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  try {
    const query = ApiQuerySchema.parse(req.query);
    const keywords = query.keywords;
    const excludeKeywords = query.excludeKeywords;

    const data = await tmdb.getDiscoverMovies({
      page: Number(query.page),
      sortBy: query.sortBy as SortOptions,
      language: req.locale ?? query.language,
      originalLanguage: query.language,
      genre: query.genre,
      studio: query.studio,
      primaryReleaseDateLte: query.primaryReleaseDateLte
        ? new Date(query.primaryReleaseDateLte).toISOString().split('T')[0]
        : undefined,
      primaryReleaseDateGte: query.primaryReleaseDateGte
        ? new Date(query.primaryReleaseDateGte).toISOString().split('T')[0]
        : undefined,
      keywords,
      excludeKeywords,
      withRuntimeGte: query.withRuntimeGte,
      withRuntimeLte: query.withRuntimeLte,
      voteAverageGte: query.voteAverageGte,
      voteAverageLte: query.voteAverageLte,
      voteCountGte: query.voteCountGte,
      voteCountLte: query.voteCountLte,
      watchProviders: query.watchProviders,
      watchRegion: query.watchRegion,
      certification: query.certification,
      certificationGte: query.certificationGte,
      certificationLte: query.certificationLte,
      certificationCountry: query.certificationCountry,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      data.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.MOVIE,
      }))
    );

    let keywordData: TmdbKeyword[] = [];
    if (keywords) {
      const splitKeywords = keywords.split(',');

      const keywordResults = await Promise.all(
        splitKeywords.map(async (keywordId) => {
          return await tmdb.getKeywordDetails({ keywordId: Number(keywordId) });
        })
      );

      keywordData = keywordResults.filter(
        (keyword): keyword is TmdbKeyword => keyword !== null
      );
    }

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      keywords: keywordData,
      results: data.results.map((result) =>
        mapMovieResult(
          result,
          media.find(
            (req) =>
              req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving popular movies', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve popular movies.',
    });
  }
});

discoverRoutes.get<{ language: string }>(
  '/movies/language/:language',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const languages = await tmdb.getLanguages();

      const language = languages.find(
        (lang) => lang.iso_639_1 === req.params.language
      );

      if (!language) {
        return next({ status: 404, message: 'Language not found.' });
      }

      const data = await tmdb.getDiscoverMovies({
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        originalLanguage: req.params.language,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.MOVIE,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        language,
        results: data.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (req) =>
                req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by language', {
        label: 'API',
        errorMessage: e.message,
        language: req.params.language,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by language.',
      });
    }
  }
);

discoverRoutes.get<{ genreId: string }>(
  '/movies/genre/:genreId',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      const genre = genres.find(
        (genre) => genre.id === Number(req.params.genreId)
      );

      if (!genre) {
        return next({ status: 404, message: 'Genre not found.' });
      }

      const data = await tmdb.getDiscoverMovies({
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        genre: req.params.genreId as string,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.MOVIE,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        genre,
        results: data.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (req) =>
                req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by genre', {
        label: 'API',
        errorMessage: e.message,
        genreId: req.params.genreId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by genre.',
      });
    }
  }
);

discoverRoutes.get<{ studioId: string }>(
  '/movies/studio/:studioId',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const studio = await tmdb.getStudio(Number(req.params.studioId));

      const data = await tmdb.getDiscoverMovies({
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        studio: req.params.studioId as string,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.MOVIE,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        studio: mapProductionCompany(studio),
        results: data.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by studio', {
        label: 'API',
        errorMessage: e.message,
        studioId: req.params.studioId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by studio.',
      });
    }
  }
);

discoverRoutes.get('/movies/upcoming', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const date = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  try {
    const data = await tmdb.getDiscoverMovies({
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
      primaryReleaseDateGte: date,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      data.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.MOVIE,
      }))
    );

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: data.results.map((result) =>
        mapMovieResult(
          result,
          media.find(
            (med) =>
              med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming movies', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming movies.',
    });
  }
});

discoverRoutes.get('/tv', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  try {
    const query = ApiQuerySchema.parse(req.query);
    const keywords = query.keywords;
    const excludeKeywords = query.excludeKeywords;
    const data = await tmdb.getDiscoverTv({
      page: Number(query.page),
      sortBy: query.sortBy as SortOptions,
      language: req.locale ?? query.language,
      genre: query.genre,
      network: query.network ? Number(query.network) : undefined,
      firstAirDateLte: query.firstAirDateLte
        ? new Date(query.firstAirDateLte).toISOString().split('T')[0]
        : undefined,
      firstAirDateGte: query.firstAirDateGte
        ? new Date(query.firstAirDateGte).toISOString().split('T')[0]
        : undefined,
      originalLanguage: query.language,
      keywords,
      excludeKeywords,
      withRuntimeGte: query.withRuntimeGte,
      withRuntimeLte: query.withRuntimeLte,
      voteAverageGte: query.voteAverageGte,
      voteAverageLte: query.voteAverageLte,
      voteCountGte: query.voteCountGte,
      voteCountLte: query.voteCountLte,
      watchProviders: query.watchProviders,
      watchRegion: query.watchRegion,
      withStatus: query.status,
      certification: query.certification,
      certificationGte: query.certificationGte,
      certificationLte: query.certificationLte,
      certificationCountry: query.certificationCountry,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      data.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      }))
    );

    let keywordData: TmdbKeyword[] = [];
    if (keywords) {
      const splitKeywords = keywords.split(',');

      const keywordResults = await Promise.all(
        splitKeywords.map(async (keywordId) => {
          return await tmdb.getKeywordDetails({ keywordId: Number(keywordId) });
        })
      );

      keywordData = keywordResults.filter(
        (keyword): keyword is TmdbKeyword => keyword !== null
      );
    }

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      keywords: keywordData,
      results: data.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (med) => med.tmdbId === result.id && med.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving popular series', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve popular series.',
    });
  }
});

discoverRoutes.get<{ language: string }>(
  '/tv/language/:language',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const languages = await tmdb.getLanguages();

      const language = languages.find(
        (lang) => lang.iso_639_1 === req.params.language
      );

      if (!language) {
        return next({ status: 404, message: 'Language not found.' });
      }

      const data = await tmdb.getDiscoverTv({
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        originalLanguage: req.params.language,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.TV,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        language,
        results: data.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by language', {
        label: 'API',
        errorMessage: e.message,
        language: req.params.language,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by language.',
      });
    }
  }
);

discoverRoutes.get<{ genreId: string }>(
  '/tv/genre/:genreId',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);

    try {
      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      const genre = genres.find(
        (genre) => genre.id === Number(req.params.genreId)
      );

      if (!genre) {
        return next({ status: 404, message: 'Genre not found.' });
      }

      const data = await tmdb.getDiscoverTv({
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        genre: req.params.genreId,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.TV,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        genre,
        results: data.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by genre', {
        label: 'API',
        errorMessage: e.message,
        genreId: req.params.genreId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by genre.',
      });
    }
  }
);

discoverRoutes.get<{ networkId: string }>(
  '/tv/network/:networkId',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const network = await tmdb.getNetwork(Number(req.params.networkId));

      const data = await tmdb.getDiscoverTv({
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        network: Number(req.params.networkId),
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.TV,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        network: mapNetwork(network),
        results: data.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by network', {
        label: 'API',
        errorMessage: e.message,
        networkId: req.params.networkId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by network.',
      });
    }
  }
);

discoverRoutes.get('/tv/upcoming', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const date = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  try {
    const data = await tmdb.getDiscoverTv({
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
      firstAirDateGte: date,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      data.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      }))
    );

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: data.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (med) => med.tmdbId === result.id && med.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming series', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming series.',
    });
  }
});

discoverRoutes.get('/trending', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);

  try {
    const mediaType = (req.query.mediaType as 'all' | 'movie' | 'tv') ?? 'all';
    const timeWindow =
      (req.query.timeWindow as 'day' | 'week') === 'week' ? 'week' : 'day';
    const language = (req.query.language as string) ?? req.locale;
    const page = Number(req.query.page);

    const trendingFetchers = {
      movie: async () => ({
        data: await tmdb.getMovieTrending({ page, language, timeWindow }),
        mapper: mapMovieResult,
        type: MediaType.MOVIE,
      }),
      tv: async () => ({
        data: await tmdb.getTvTrending({ page, language, timeWindow }),
        mapper: mapTvResult,
        type: MediaType.TV,
      }),
      all: async () => ({
        data: await tmdb.getAllTrending({ page, language, timeWindow }),
        mapper: (result: any, media?: Media) => {
          if (isMovie(result)) {
            return mapMovieResult(result, media);
          } else if (isPerson(result)) {
            return mapPersonResult(result);
          } else if (isCollection(result)) {
            return mapCollectionResult(result);
          } else {
            return mapTvResult(result, media);
          }
        },
        type: null,
      }),
    } as const;

    const { data, mapper, type } = await trendingFetchers[mediaType]();

    const media = await Media.getRelatedMedia(
      req.user,
      data.results.map((result) => ({
        tmdbId: result.id,
        mediaType: isMovie(result) ? MediaType.MOVIE : MediaType.TV,
      }))
    );

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: data.results.map((result) => {
        // - If "type" is set (case: "movie" or "tv"), the mediaType must also match.
        // - If "type" is not set (case: "all"), only filter by tmdbId.
        const selectedMedia = media.find(
          (med) =>
            med.tmdbId === result.id && (type ? med.mediaType === type : true)
        );

        return mapper(result, selectedMedia);
      }),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving trending items', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve trending items.',
    });
  }
});

discoverRoutes.get<{ keywordId: string }>(
  '/keyword/:keywordId/movies',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const data = await tmdb.getMoviesByKeyword({
        keywordId: Number(req.params.keywordId),
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
      });

      const media = await Media.getRelatedMedia(
        req.user,
        data.results.map((result) => ({
          tmdbId: result.id,
          mediaType: MediaType.MOVIE,
        }))
      );

      return res.status(200).json({
        page: data.page,
        totalPages: data.total_pages,
        totalResults: data.total_results,
        results: data.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by keyword', {
        label: 'API',
        errorMessage: e.message,
        keywordId: req.params.keywordId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by keyword.',
      });
    }
  }
);

discoverRoutes.get<{ language: string }, GenreSliderItem[]>(
  '/genreslider/movie',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const mappedGenres: GenreSliderItem[] = [];

      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      await Promise.all(
        genres.map(async (genre) => {
          const genreData = await tmdb.getDiscoverMovies({
            genre: genre.id.toString(),
          });

          mappedGenres.push({
            id: genre.id,
            name: genre.name,
            backdrops: genreData.results
              .filter((title) => !!title.backdrop_path)
              .map((title) => title.backdrop_path) as string[],
          });
        })
      );

      const sortedData = sortBy(mappedGenres, 'name');

      return res.status(200).json(sortedData);
    } catch (e) {
      logger.debug('Something went wrong retrieving the movie genre slider', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movie genre slider.',
      });
    }
  }
);

discoverRoutes.get<{ language: string }, GenreSliderItem[]>(
  '/genreslider/tv',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const mappedGenres: GenreSliderItem[] = [];

      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      await Promise.all(
        genres.map(async (genre) => {
          const genreData = await tmdb.getDiscoverTv({
            genre: genre.id.toString(),
          });

          mappedGenres.push({
            id: genre.id,
            name: genre.name,
            backdrops: genreData.results
              .filter((title) => !!title.backdrop_path)
              .map((title) => title.backdrop_path) as string[],
          });
        })
      );

      const sortedData = sortBy(mappedGenres, 'name');

      return res.status(200).json(sortedData);
    } catch (e) {
      logger.debug('Something went wrong retrieving the series genre slider', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series genre slider.',
      });
    }
  }
);

discoverRoutes.get<Record<string, unknown>, WatchlistResponse>(
  '/watchlist',
  async (req, res) => {
    const userRepository = getRepository(User);
    const itemsPerPage = 20;
    const page = req.query.page ? Number(req.query.page) : 1;
    const offset = (page - 1) * itemsPerPage;

    const activeUser = await userRepository.findOne({
      where: { id: req.user?.id },
      select: ['id', 'plexToken'],
    });

    if (activeUser && !activeUser?.plexToken) {
      // Non-Plex users can only see their own watchlist
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: activeUser?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }
    if (!activeUser?.plexToken) {
      // We will just return an empty array if the user has no Plex token
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    // List watchlist from Plex
    const plexTV = new PlexTvAPI(activeUser.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
    });
  }
);

export default discoverRoutes;
