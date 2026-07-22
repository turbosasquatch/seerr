import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';

export interface MdbListItem {
  id?: number;
  mediatype: 'movie' | 'show';
  imdb_id?: string;
  tvdb_id?: number;
  ids?: {
    imdb?: string;
    tmdb?: number;
    tvdb?: number;
  };
  rank?: number;
  title: string;
}

interface MdbListPagination {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface MdbListItemsResponse {
  movies: MdbListItem[];
  shows: MdbListItem[];
  pagination: MdbListPagination;
}

class MdbListAPI extends ExternalAPI {
  constructor(apiKey: string) {
    super(
      'https://api.mdblist.com',
      { apikey: apiKey },
      {
        nodeCache: cacheManager.getCache('mdblist').data,
        rateLimit: {
          maxRequests: 10,
          maxRPS: 5,
        },
      }
    );
  }

  public getListItems = async ({
    listUrl,
    limit = 20,
    offset = 0,
  }: {
    listUrl: string;
    limit?: number;
    offset?: number;
  }): Promise<MdbListItemsResponse> => {
    const endpoint = this.getItemsEndpoint(listUrl);

    return this.get<MdbListItemsResponse>(
      endpoint,
      {
        params: {
          limit,
          offset,
        },
      },
      86400
    );
  };

  private getItemsEndpoint(listUrl: string): string {
    let url: URL;

    try {
      url = new URL(listUrl);
    } catch {
      throw new Error('Invalid MDBList URL.');
    }

    const isMdbListHost =
      url.hostname === 'mdblist.com' || url.hostname === 'www.mdblist.com';
    const pathParts = url.pathname.split('/').filter(Boolean);
    const isListPath =
      pathParts[0] === 'lists' &&
      ((pathParts.length === 3 && pathParts[1] && pathParts[2]) ||
        (pathParts.length === 4 &&
          pathParts[1] &&
          pathParts[2] === 'external' &&
          pathParts[3]));

    if (!isMdbListHost || !isListPath) {
      throw new Error('Invalid MDBList URL.');
    }

    return `/${pathParts.join('/')}/items`;
  }
}

export default MdbListAPI;
