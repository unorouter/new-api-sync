export interface Sub2ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface Sub2ApiAccount {
  id: number;
  name: string;
  platform: string;
  type: string;
  status: string;
  model_mapping?: Record<string, string>;
}

export interface Sub2ApiModel {
  id: string;
  type: string;
  display_name?: string;
}

export interface Sub2ApiGroup {
  id: number;
  name: string;
  platform: string;
  status: string;
}

export interface Sub2ApiKey {
  id: number;
  key: string;
  name: string;
  group_id?: number;
  status: string;
}
