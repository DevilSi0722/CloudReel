import logo from '../assets/brand/cloudreel-mark.svg';

export default function BrandMark({small = false}: {small?: boolean}) {
  return <img className={`brand-mark${small ? ' small' : ''}`} src={logo} alt="" aria-hidden="true" />;
}
